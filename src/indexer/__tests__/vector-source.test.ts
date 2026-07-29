import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { loadCanonicalVectorDocument } from '../vector-source.ts';

const VECTOR_SOURCE_SCHEMA = `
CREATE TABLE oracle_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  concepts TEXT NOT NULL,
  project TEXT,
  created_at INTEGER NOT NULL,
  superseded_by TEXT
);
CREATE TABLE oracle_fts (id TEXT NOT NULL, content TEXT NOT NULL);
`;

test('loadCanonicalVectorDocument returns null when document is superseded', () => {
  // Given a queued document that became inactive before its worker claim.
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(VECTOR_SOURCE_SCHEMA);
    sqlite.prepare(`
      INSERT INTO oracle_documents
        (id, tenant_id, type, source_file, concepts, project, created_at, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('stale-doc', 'default', 'learning', 'stale.md', '[]', null, 1, 'current-doc');
    sqlite.prepare('INSERT INTO oracle_fts (id, content) VALUES (?, ?)').run('stale-doc', 'stale content');

    // When the daemon reloads canonical vector state by id.
    const document = loadCanonicalVectorDocument(sqlite, 'stale-doc');

    // Then stale work is treated as missing and cannot recreate a deleted vector.
    expect(document).toBeNull();
  } finally {
    sqlite.close();
  }
});
