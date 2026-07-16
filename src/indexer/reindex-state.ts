import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { indexingJobs, oracleDocuments, vectorIndexManifest } from '../db/schema.ts';
import { asOracleDb, type OracleDb, type OracleDbInput } from '../db/drizzle-input.ts';
import type { OracleDocument } from '../types.ts';
import { enqueueIndexJob } from './jobs.ts';
import { vectorContentHash } from './vector-index-manifest.ts';
import { loadCanonicalVectorDocumentFromDb } from './vector-source.ts';

export type ModelRegistry = Record<string, { collection: string }>;

export interface VectorQueueStats {
  queued: number;
  skipped: number;
  failed: number;
}

const REINDEX_REASON = 'superseded by indexer reindex';

export function supersedeReplacedSourceDocs(
  input: OracleDbInput,
  documents: OracleDocument[],
  tenantId?: string,
): number {
  const db = asOracleDb(input);
  const bySource = new Map<string, string[]>();
  for (const doc of documents) {
    const ids = bySource.get(doc.source_file) ?? [];
    ids.push(doc.id);
    bySource.set(doc.source_file, ids);
  }

  let superseded = 0;
  const now = Date.now();
  for (const [sourceFile, currentIds] of bySource) {
    const stale = activeIndexerIdsForSource(db, sourceFile, currentIds, tenantId);
    if (stale.length === 0) continue;
    const successorId = currentIds[0];
    db.update(oracleDocuments)
      .set({ supersededBy: successorId, supersededAt: now, supersededReason: REINDEX_REASON })
      .where(and(
        inArray(oracleDocuments.id, stale),
        isNull(oracleDocuments.supersededBy),
        isNull(oracleDocuments.supersededAt),
      ))
      .run();
    superseded += stale.length;
  }
  return superseded;
}

/**
 * Reconcile fresh SQLite/FTS chunks into hash-keyed vector jobs.
 *
 * No parser-text comparison is used. The canonical persisted vector payload is
 * hashed after `storeDocuments()` so FTS enrichment, metadata and daemon input
 * are the same bytes. A matching manifest is the only successful-vector proof.
 */
export function enqueueVectorReindexJobs(
  input: OracleDbInput,
  documents: OracleDocument[],
  models: ModelRegistry,
): VectorQueueStats {
  const db = asOracleDb(input);
  const modelKeys = Object.keys(models);
  const docIds = [...new Set(documents.map((doc) => doc.id))];
  const stats: VectorQueueStats = { queued: 0, skipped: 0, failed: 0 };
  if (docIds.length === 0 || modelKeys.length === 0) return stats;
  if (!hasIndexingJobsTable(db)) {
    stats.failed = docIds.length * modelKeys.length;
    return stats;
  }

  for (const docId of docIds) {
    const vectorDoc = loadCanonicalVectorDocumentFromDb(db, docId);
    if (!vectorDoc) {
      stats.failed += modelKeys.length;
      continue;
    }
    const contentHash = vectorContentHash(vectorDoc);
    for (const modelKey of modelKeys) {
      try {
        if (!needsVectorJob(db, docId, modelKey, contentHash)) {
          stats.skipped++;
          continue;
        }
        const jobs = enqueueIndexJob(db, { docId, contentHash, modelKey, models });
        stats.queued += jobs.length;
        if (jobs.length === 0) stats.failed++;
      } catch {
        stats.failed++;
      }
    }
  }
  return stats;
}

/** Reconcile all canonical rows, used by the former direct-write cron command. */
export function enqueueCanonicalVectorJobs(
  input: OracleDbInput,
  docIds: string[],
  models: ModelRegistry,
): VectorQueueStats {
  return enqueueVectorReindexJobs(input, docIds.map((id) => ({ id } as OracleDocument)), models);
}

function activeIndexerIdsForSource(
  db: OracleDb,
  sourceFile: string,
  currentIds: string[],
  tenantId?: string,
): string[] {
  if (currentIds.length === 0) return [];
  const rows = db.select({ id: oracleDocuments.id })
    .from(oracleDocuments)
    .where(and(
      eq(oracleDocuments.sourceFile, sourceFile),
      notInArray(oracleDocuments.id, currentIds),
      activeIndexerWhere(tenantId),
    ))
    .all();
  return rows.map((row) => row.id);
}

function activeIndexerWhere(tenantId?: string) {
  return and(
    or(eq(oracleDocuments.createdBy, 'indexer'), isNull(oracleDocuments.createdBy))!,
    isNull(oracleDocuments.supersededBy),
    isNull(oracleDocuments.supersededAt),
    tenantId ? eq(oracleDocuments.tenantId, tenantId) : undefined,
  )!;
}

/**
 * Does the vector job queue exist?
 *
 * This returned `false` unconditionally, so `enqueueVectorReindexJobs` short-circuited on
 * every run and **the indexer never queued a single vector job**. Measured on a fresh DB
 * where the table demonstrably exists:
 *
 * ```
 * raw sqlite sees table          : true
 * db.get(sql`SELECT name …`)     : ["indexing_jobs"]     ← a positional array
 * row?.name === 'indexing_jobs'  : false
 * ```
 *
 * Drizzle's `db.get()` with a raw `sql` template yields the row as an **array**, not an
 * object. The `<{ name: string }>` type argument described a shape that never existed at
 * runtime — a generic is an assertion, not a check, so `tsc` had nothing to catch. The two
 * `tests/indexer/reindex-hardening.test.ts` cases have been failing on this since #2434 and
 * were invisible because CI did not run `tests/indexer/` (#2853).
 *
 * Both shapes are handled: a raw `sql` template gives the array, while a query built from a
 * Drizzle table gives the object, and this helper should not care which the caller used.
 */
function hasIndexingJobsTable(db: OracleDb): boolean {
  try {
    const row = db.get<{ name?: string } | [string] | undefined>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'indexing_jobs'`,
    );
    if (!row) return false;
    const name = Array.isArray(row) ? row[0] : row.name;
    return name === 'indexing_jobs';
  } catch {
    return false;
  }
}

function needsVectorJob(
  db: OracleDb,
  docId: string,
  modelKey: string,
  contentHash: string,
): boolean {
  const manifest = db.select({ contentHash: vectorIndexManifest.contentHash })
    .from(vectorIndexManifest)
    .where(and(eq(vectorIndexManifest.chunkId, docId), eq(vectorIndexManifest.modelKey, modelKey)))
    .get();
  if (manifest?.contentHash === contentHash) return false;

  const inFlight = db.select({ status: indexingJobs.status })
    .from(indexingJobs)
    .where(and(
      eq(indexingJobs.docId, docId),
      eq(indexingJobs.modelKey, modelKey),
      eq(indexingJobs.contentHash, contentHash),
      eq(indexingJobs.operation, 'upsert'),
    ))
    .all();
  return !inFlight.some((row) => row.status === 'pending' || row.status === 'claimed');
}
