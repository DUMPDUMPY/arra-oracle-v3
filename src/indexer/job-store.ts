/**
 * Shared vocabulary for the durable vector-indexing queue.
 *
 * Kept separate from jobs.ts so the claim path (job-claim.ts) and the
 * enqueue/complete path (jobs.ts) can share the record shapes and the Drizzle
 * accessor without importing each other.
 */

import type Database from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../db/schema.ts';

export type VectorOperation = 'upsert' | 'delete';

export interface EnqueuedJob {
  id: string;
  docId: string;
  modelKey: string;
  collection: string;
  contentHash: string;
  operation: VectorOperation;
}

export interface IndexedVectorJob extends EnqueuedJob {
  sourceFile: string;
}

export type JobsDb = Database | BunSQLiteDatabase<typeof schema>;

/** Crash-recovery lease: a claimed job older than this is reclaimable. */
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;

export function asDrizzle(conn: JobsDb): BunSQLiteDatabase<typeof schema> {
  if ('select' in conn && typeof conn.select === 'function') {
    return conn as BunSQLiteDatabase<typeof schema>;
  }
  return drizzle(conn as Database, { schema });
}
