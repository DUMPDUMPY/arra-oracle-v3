/**
 * Claim path for the durable vector-indexing queue.
 *
 * A claim flips a job from pending to claimed and hands out a finite
 * crash-recovery lease. Delivery is exclusive: the pending -> claimed
 * transition is guarded, so two workers cannot end up owning the same job.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { indexingJobs } from '../db/schema.ts';
import {
  asDrizzle,
  DEFAULT_LEASE_MS,
  type EnqueuedJob,
  type JobsDb,
  type VectorOperation,
} from './job-store.ts';

/** Flip one specific pending job to claimed.
 *
 * Returns the row only when THIS call performed the pending -> claimed
 * transition. The `status = 'pending'` guard is the claim token: a caller that
 * read a candidate id earlier, while another worker already claimed it, gets
 * null instead of stealing the job.
 */
export function claimJobById(
  conn: JobsDb,
  jobId: string,
  opts: { now?: number; leaseMs?: number } = {},
): EnqueuedJob | null {
  const db = asDrizzle(conn);
  const now = opts.now ?? Date.now();
  const leaseExpiresAt = now + (opts.leaseMs ?? DEFAULT_LEASE_MS);
  const row = db.update(indexingJobs)
    .set({
      status: 'claimed',
      claimedAt: now,
      leaseExpiresAt,
      attempts: sql`${indexingJobs.attempts} + 1`,
    })
    .where(and(eq(indexingJobs.id, jobId), eq(indexingJobs.status, 'pending')))
    .returning({
      id: indexingJobs.id,
      docId: indexingJobs.docId,
      modelKey: indexingJobs.modelKey,
      collection: indexingJobs.collection,
      contentHash: indexingJobs.contentHash,
      operation: indexingJobs.operation,
    })
    .get();

  return row ? { ...row, operation: row.operation as VectorOperation } : null;
}

/** Claim one pending job and issue a finite crash-recovery lease.
 *
 * Two statements on purpose. A single `UPDATE ... WHERE id IN (SELECT ...)` reads
 * its subquery before it writes, so SQLite opens a deferred transaction and then
 * has to upgrade it to a write transaction. When another writer committed in
 * between, that upgrade fails with SQLITE_BUSY (snapshot) and the busy handler is
 * NOT invoked — busy_timeout cannot rescue it, and the daemon used to log
 * "queue claim deferred: database is locked" on every contended poll. Splitting
 * the read and the write gives each statement its own transaction, so the write
 * waits for the lock instead of failing outright.
 */
export function claimNextJob(
  conn: JobsDb,
  modelKey: string,
  opts: { now?: number; leaseMs?: number } = {},
): EnqueuedJob | null {
  const db = asDrizzle(conn);
  const next = db.select({ id: indexingJobs.id })
    .from(indexingJobs)
    .where(and(eq(indexingJobs.status, 'pending'), eq(indexingJobs.modelKey, modelKey)))
    .orderBy(asc(indexingJobs.createdAt))
    .limit(1)
    .get();
  if (!next) return null;
  return claimJobById(conn, next.id, opts);
}

/** Claim a small FIFO batch. A claim is exclusive — the pending -> claimed
 * transition is guarded, so competing daemons never receive the same job;
 * batching only changes work scheduling, not delivery semantics. */
export function claimNextJobs(conn: JobsDb, modelKey: string, batchSize: number): EnqueuedJob[] {
  const jobs: EnqueuedJob[] = [];
  const size = Math.max(1, Math.trunc(batchSize));
  for (let i = 0; i < size; i++) {
    const job = claimNextJob(conn, modelKey);
    if (!job) break;
    jobs.push(job);
  }
  return jobs;
}
