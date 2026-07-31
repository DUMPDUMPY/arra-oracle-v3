/**
 * Tests for backup file-lock to prevent race conditions
 * when concurrent reindex processes run close together.
 *
 * @see https://github.com/Soul-Brews-Studio/arra-oracle-v3/issues/1037
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from 'bun:sqlite';
import { acquireLock, backupDatabase, releaseLock } from '../backup.ts';

describe('backup file lock', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-backup-test-'));
    lockPath = path.join(tmpDir, 'test.db.backup.lock');
  });

  afterEach(() => {
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('acquires lock when no lock exists', () => {
    expect(acquireLock(lockPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it('fails to acquire when lock already held', () => {
    expect(acquireLock(lockPath)).toBe(true);
    expect(acquireLock(lockPath)).toBe(false);
    releaseLock(lockPath);
  });

  it('allows re-acquire after release', () => {
    expect(acquireLock(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(acquireLock(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it('writes PID to lock file', () => {
    acquireLock(lockPath);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(content).toBe(String(process.pid));
    releaseLock(lockPath);
  });

  it('reclaims stale lock (mtime > threshold)', () => {
    // Create a lock file and back-date it
    fs.writeFileSync(lockPath, '99999\n');
    const staleTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    fs.utimesSync(lockPath, new Date(staleTime), new Date(staleTime));

    // Should reclaim the stale lock
    expect(acquireLock(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(content).toBe(String(process.pid));
    releaseLock(lockPath);
  });

  it('does not reclaim fresh lock from another process', () => {
    // Create a lock file with a recent mtime (simulating another live process)
    fs.writeFileSync(lockPath, '99999\n');
    // mtime is "now" by default — well within the 5-minute threshold

    expect(acquireLock(lockPath)).toBe(false);
    // Clean up manually since we didn't acquire
    fs.unlinkSync(lockPath);
  });

  it('releaseLock is safe when lock already removed', () => {
    // Should not throw
    expect(() => releaseLock(lockPath)).not.toThrow();
  });
});

describe('backup rotation', () => {
  let tmpDir: string;
  let dbPath: string;
  let oldKeep: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-backup-rotation-'));
    dbPath = path.join(tmpDir, 'oracle.db');
    oldKeep = process.env.ORACLE_BACKUP_KEEP;
    process.env.ORACLE_BACKUP_KEEP = '2';

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE oracle_documents (
        id TEXT PRIMARY KEY,
        type TEXT,
        source_file TEXT,
        concepts TEXT,
        project TEXT
      );
      CREATE TABLE oracle_fts (id TEXT PRIMARY KEY, content TEXT);
      INSERT INTO oracle_documents VALUES ('d1', 'learning', 'a.md', '[]', 'p');
      INSERT INTO oracle_fts VALUES ('d1', 'content');
    `);
    db.close();
  });

  afterEach(() => {
    if (oldKeep === undefined) delete process.env.ORACLE_BACKUP_KEEP;
    else process.env.ORACLE_BACKUP_KEEP = oldKeep;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('ignores non-timestamp backup artifacts when rotating timestamped backups', () => {
    for (const name of [
      'oracle.db.backup-pre-alpha1608-20260707-shm',
      'oracle.db.backup-pre-alpha1608-20260707-wal',
      'oracle.db.backup-2026-07-30T00-00-00-000Z',
      'oracle.db.backup-2026-07-30T01-00-00-000Z',
      'oracle.db.backup-2026-07-30T02-00-00-000Z',
    ]) fs.writeFileSync(path.join(tmpDir, name), 'x');

    const db = new Database(dbPath);
    backupDatabase(db, { dbPath } as any);
    db.close();

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('oracle.db.backup-'));
    expect(files).toContain('oracle.db.backup-pre-alpha1608-20260707-shm');
    expect(files).toContain('oracle.db.backup-pre-alpha1608-20260707-wal');

    const timestamped = files.filter(f => /^oracle\.db\.backup-\d{4}-/.test(f));
    expect(timestamped).toHaveLength(2);
  });
});
