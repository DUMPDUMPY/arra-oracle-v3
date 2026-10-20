/**
 * Oracle Verify Handler
 *
 * Compares ψ/ files on disk vs DB index.
 * Detects: healthy, missing, orphaned, drifted, untracked files.
 *
 * Philosophy: "Nothing is Deleted" — orphans are flagged, not removed.
 */

import { and, eq } from 'drizzle-orm';
import { db, oracleDocuments } from '../db/index.ts';
import { currentTenantId } from '../middleware/tenant.ts';
import { loadDbFileMap } from './db-scan.ts';
import { scanDisk } from './disk-scan.ts';

export interface VerifyResult {
  counts: {
    healthy: number;
    missing: number;
    orphaned: number;
    drifted: number;
    untracked: number;
  };
  missing: string[];
  orphaned: string[];
  drifted: string[];
  untracked: string[];
  mismatches: VerifyMismatch[];
  recommendation: string;
  fixedOrphans?: number;
}

export interface VerifyMismatch {
  kind: 'missing' | 'orphaned' | 'drifted' | 'untracked';
  sourceFile: string;
  ids?: string[];
  indexedAt?: number;
  mtimeMs?: number;
}

export function verifyKnowledgeBase(opts: {
  check?: boolean;
  type?: string;
  repoRoot: string;
}): VerifyResult {
  const { check = true, type, repoRoot } = opts;
  const tenantId = currentTenantId();

  const { diskFiles, untrackedPathSet } = scanDisk(repoRoot, tenantId);
  const dbFileMap = loadDbFileMap(repoRoot, type, tenantId);

  // 3. Classify
  const healthy: string[] = [];
  const missing: string[] = [];
  const drifted: string[] = [];
  const orphaned: string[] = [];

  // Tenant-scoped requests can only prove ownership for DB-backed files.
  // Keep global disk-only "missing"/"untracked" reporting for unscoped runs.
  const pathsToCheck = tenantId
    ? dbFileMap.keys()
    : [...diskFiles.keys()].filter((relPath) => !untrackedPathSet.has(relPath) || dbFileMap.has(relPath));
  for (const relPath of pathsToCheck) {
    const mtimeMs = diskFiles.get(relPath);
    const dbEntry = dbFileMap.get(relPath);
    if (!dbEntry) {
      // File on disk, not in DB
      missing.push(relPath);
    } else if (mtimeMs === undefined) {
      continue;
    } else {
      // File exists in both — check drift
      if (mtimeMs > dbEntry.indexedAt) {
        drifted.push(relPath);
      } else {
        healthy.push(relPath);
      }
    }
  }

  // Check each DB entry for orphans (in DB, not on disk)
  const seenDbFiles = new Set<string>();
  for (const [sourceFile] of dbFileMap) {
    if (seenDbFiles.has(sourceFile)) continue;
    seenDbFiles.add(sourceFile);

    if (!diskFiles.has(sourceFile)) {
      orphaned.push(sourceFile);
    }
  }

  // 4. Count inbox files that are still outside the DB index.
  const untracked = tenantId
    ? []
    : [...untrackedPathSet].filter((sourceFile) => !dbFileMap.has(sourceFile)).sort();

  // 5. Auto-fix orphans if check=false
  let fixedOrphans = 0;
  if (!check && orphaned.length > 0) {
    const now = Date.now();
    for (const sourceFile of orphaned) {
      const entry = dbFileMap.get(sourceFile);
      if (entry) {
        for (const id of entry.ids) {
          const where = tenantId
            ? and(eq(oracleDocuments.id, id), eq(oracleDocuments.tenantId, tenantId))
            : eq(oracleDocuments.id, id);
          db.update(oracleDocuments)
            .set({
              supersededBy: '_verified_orphan',
              supersededAt: now,
              supersededReason: 'File missing from disk (oracle_verify)',
            })
            .where(where)
            .run();
          fixedOrphans++;
        }
      }
    }
  }

  // 6. Build recommendation
  const issues = missing.length + orphaned.length + drifted.length;
  let recommendation = '';
  if (issues === 0) {
    recommendation = 'Knowledge base is healthy. All files match DB index.';
  } else {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`${missing.length} missing from index`);
    if (orphaned.length > 0) parts.push(`${orphaned.length} orphaned in DB`);
    if (drifted.length > 0) parts.push(`${drifted.length} drifted since last index`);
    recommendation = `Run \`bun run index\` to fix ${issues} issues (${parts.join(', ')})`;
  }

  if (fixedOrphans > 0) {
    recommendation += `. Flagged ${fixedOrphans} orphaned entries as '_verified_orphan'.`;
  }

  const dbDetails = (sourceFile: string) => dbFileMap.get(sourceFile) ?? {};
  const mismatches: VerifyMismatch[] = [
    ...missing.map((sourceFile) => ({ kind: 'missing' as const, sourceFile, mtimeMs: diskFiles.get(sourceFile) })),
    ...orphaned.map((sourceFile) => ({ kind: 'orphaned' as const, sourceFile, ...dbDetails(sourceFile) })),
    ...drifted.map((sourceFile) => ({
      kind: 'drifted' as const,
      sourceFile,
      mtimeMs: diskFiles.get(sourceFile),
      ...dbDetails(sourceFile),
    })),
    ...untracked.map((sourceFile) => ({ kind: 'untracked' as const, sourceFile })),
  ];

  return {
    counts: {
      healthy: healthy.length,
      missing: missing.length,
      orphaned: orphaned.length,
      drifted: drifted.length,
      untracked: untracked.length,
    },
    missing,
    orphaned,
    drifted,
    untracked,
    mismatches,
    recommendation,
    ...(fixedOrphans > 0 ? { fixedOrphans } : {}),
  };
}
