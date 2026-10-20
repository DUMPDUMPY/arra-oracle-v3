/**
 * DB side of the verify pass: which source files the index knows about, and
 * under which document ids.
 *
 * Multiple DB entries can point at the same source file (chunked docs), so
 * the map keeps every id and the newest indexedAt.
 */
import path from 'path';
import { existsSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { db, oracleDocuments } from '../db/index.ts';
import { normalizeSourceFile } from './paths.ts';

const PROJECT_PATH_RE = /^(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/;

export interface DbFileEntry {
  indexedAt: number;
  ids: string[];
}

export function canonicalSourceFile(sourceFile: string, project: string | null, repoRoot: string): string | null {
  const normalized = normalizeSourceFile(sourceFile, repoRoot);
  if (!normalized || !project || !PROJECT_PATH_RE.test(project) || !normalized.startsWith('ψ/')) {
    return normalized;
  }

  // Older learn writers persisted flat ψ/ paths. Prefer their project-first
  // successor when that canonical file exists on disk.
  const projectFirst = `${project}/${normalized}`;
  const repoBase = path.resolve(repoRoot);
  const candidate = path.resolve(repoBase, projectFirst);
  return candidate.startsWith(`${repoBase}${path.sep}`) && existsSync(candidate)
    ? projectFirst
    : normalized;
}

export function loadDbFileMap(
  repoRoot: string,
  type: string | undefined,
  tenantId: string | null | undefined,
): Map<string, DbFileEntry> {
  const normalizedType = type?.trim();
  const typeFilter = normalizedType && normalizedType !== 'all' ? normalizedType : undefined;
  const fields = {
    id: oracleDocuments.id,
    sourceFile: oracleDocuments.sourceFile,
    indexedAt: oracleDocuments.indexedAt,
    type: oracleDocuments.type,
    project: oracleDocuments.project,
  };
  const activeDocWhere = and(
    isNull(oracleDocuments.supersededBy),
    isNull(oracleDocuments.supersededAt),
  )!;
  const dbRows = typeFilter && tenantId
    ? db.select(fields)
        .from(oracleDocuments)
        .where(and(eq(oracleDocuments.type, typeFilter), eq(oracleDocuments.tenantId, tenantId), activeDocWhere))
        .all()
    : typeFilter
    ? db.select({
        ...fields,
      })
        .from(oracleDocuments)
        .where(and(eq(oracleDocuments.type, typeFilter), activeDocWhere))
        .all()
    : tenantId
      ? db.select(fields)
        .from(oracleDocuments)
        .where(and(eq(oracleDocuments.tenantId, tenantId), activeDocWhere))
        .all()
    : db.select(fields)
        .from(oracleDocuments)
        .where(activeDocWhere)
        .all();

  const dbFileMap = new Map<string, DbFileEntry>();
  for (const row of dbRows) {
    const sourceFile = canonicalSourceFile(row.sourceFile, row.project, repoRoot);
    if (!sourceFile) continue;
    const existing = dbFileMap.get(sourceFile);
    if (existing) {
      existing.ids.push(row.id);
      // Use the latest indexedAt
      if (row.indexedAt > existing.indexedAt) {
        existing.indexedAt = row.indexedAt;
      }
    } else {
      dbFileMap.set(sourceFile, { indexedAt: row.indexedAt, ids: [row.id] });
    }
  }
  return dbFileMap;
}
