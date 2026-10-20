/**
 * Claim-path tests: exclusive delivery and the pending -> claimed guard.
 *
 * The queue hands a job to exactly one worker. A second worker that read the
 * same candidate id before the first one committed must not be able to steal
 * the row, and the losing attempt must not mutate it.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { enqueueIndexJob, claimJobById, claimNextJob } from '../jobs.ts';

const MIGRATION_SQL = `
CREATE TABLE indexing_jobs (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  collection TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'upsert',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  claimed_at INTEGER,
  lease_expires_at INTEGER,
  finished_at INTEGER,
  error TEXT
);
CREATE UNIQUE INDEX idx_indexing_jobs_identity ON indexing_jobs(model_key, doc_id, content_hash, operation);
CREATE INDEX idx_indexing_jobs_pending ON indexing_jobs(status, model_key, created_at)
  WHERE status IN ('pending','claimed');
`;

const MODELS = {
  'bge-m3': { collection: 'oracle_knowledge_bge_m3' },
  embeddinggemma2: { collection: 'oracle_knowledge_embeddinggemma2' },
};

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(MIGRATION_SQL);
  return db;
}

describe('claimJobById', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  it('claims a job by id when it is still pending', () => {
    const [enqueued] = enqueueIndexJob(db, { docId: 'doc-A', modelKey: 'bge-m3', models: MODELS });
    const claimed = claimJobById(db, enqueued.id);
    expect(claimed?.id).toBe(enqueued.id);
    expect(claimed?.modelKey).toBe('bge-m3');
  });

  it('rejects a second claimer that still holds a stale candidate id', () => {
    const [enqueued] = enqueueIndexJob(db, { docId: 'doc-A', modelKey: 'bge-m3', models: MODELS });
    // Two daemons read the same pending candidate before either writes.
    const staleCandidateId = enqueued.id;
    const winner = claimNextJob(db, 'bge-m3');
    expect(winner?.id).toBe(staleCandidateId);

    // The loser tries to claim the id it read before the winner committed.
    const loser = claimJobById(db, staleCandidateId);
    expect(loser).toBeNull();

    const row = db.query('SELECT status, attempts FROM indexing_jobs WHERE id = ?').get(staleCandidateId) as {
      status: string; attempts: number;
    };
    expect(row.status).toBe('claimed');
    expect(row.attempts).toBe(1);  // the losing claim did not touch the row
  });

  it('issues a crash-recovery lease on claim', () => {
    const [enqueued] = enqueueIndexJob(db, { docId: 'doc-A', modelKey: 'bge-m3', models: MODELS });
    const now = 1_800_000_000_000;
    const claimed = claimJobById(db, enqueued.id, { now, leaseMs: 60_000 });
    expect(claimed).not.toBeNull();
    const row = db.query('SELECT claimed_at, lease_expires_at FROM indexing_jobs WHERE id = ?').get(enqueued.id) as {
      claimed_at: number; lease_expires_at: number;
    };
    expect(row.claimed_at).toBe(now);
    expect(row.lease_expires_at).toBe(now + 60_000);
  });

  it('keeps claims isolated per model key', () => {
    enqueueIndexJob(db, { docId: 'doc-A', modelKey: 'bge-m3', models: MODELS });
    enqueueIndexJob(db, { docId: 'doc-A', modelKey: 'embeddinggemma2', models: MODELS });
    const claimed = claimNextJob(db, 'embeddinggemma2');
    expect(claimed?.modelKey).toBe('embeddinggemma2');
    expect(claimNextJob(db, 'embeddinggemma2')).toBeNull();
    expect(claimNextJob(db, 'bge-m3')?.modelKey).toBe('bge-m3');
  });
});
