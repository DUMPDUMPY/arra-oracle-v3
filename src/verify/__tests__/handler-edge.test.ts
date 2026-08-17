import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = path.join(tmpdir(), `arra-verify-lib-data-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const repoRoot = path.join(tmpdir(), `arra-verify-lib-repo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const originalDataDir = process.env.ORACLE_DATA_DIR;
const originalDbPath = process.env.ORACLE_DB_PATH;
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoRoot, { recursive: true });
process.env.ORACLE_DATA_DIR = dataDir;
process.env.ORACLE_DB_PATH = path.join(dataDir, 'oracle.db');

const dbModule = await import('../../db/index.ts');
dbModule.resetDefaultDatabaseForTests(process.env.ORACLE_DB_PATH);
const { db, oracleDocuments } = dbModule;
const { verifyKnowledgeBase } = await import('../handler.ts');

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const now = Date.now();
const relAbsolute = `ψ/memory/learnings/verify-absolute-${stamp}.md`;
const relBackslash = `ψ/memory/learnings/verify-backslash-${stamp}.md`;
const relOrphan = `ψ/memory/learnings/verify-orphan-${stamp}.md`;
const relProjectFirst = `github.com/acme/demo/ψ/memory/learnings/verify-project-first-${stamp}.md`;
const relProjectFirstOrphan = `github.com/acme/demo/ψ/memory/learnings/verify-project-first-orphan-${stamp}.md`;
const relCrew = `ψ/crew/reviewer/memory/learnings/verify-crew-${stamp}.md`;
const relProjectInbox = `github.com/acme/demo/ψ/inbox/handoff/verify-project-inbox-${stamp}.md`;
const relCrewInbox = `ψ/crew/reviewer/inbox/handoff/verify-crew-inbox-${stamp}.md`;
const relRootInbox = `ψ/inbox/handoff/verify-root-inbox-${stamp}.md`;
const relLegacyFlat = `ψ/memory/learnings/verify-legacy-${stamp}.md`;
const relLegacyProjectFirst = `github.com/acme/demo/ψ/memory/learnings/verify-legacy-${stamp}.md`;
const ids = {
  absolute: `verify-absolute-${stamp}`,
  backslash: `verify-backslash-${stamp}`,
  blank: `verify-blank-${stamp}`,
  orphanA: `verify-orphan-a-${stamp}`,
  orphanB: `verify-orphan-b-${stamp}`,
  projectFirst: `verify-project-first-${stamp}`,
  projectFirstOrphan: `verify-project-first-orphan-${stamp}`,
  crew: `verify-crew-${stamp}`,
};

function writeRepoFile(relPath: string) {
  const fullPath = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `# ${relPath}\n`);
}

function seedDoc(id: string, sourceFile: string, options: { project?: string; superseded?: boolean } = {}) {
  db.insert(oracleDocuments).values({
    id,
    type: 'learning',
    concepts: '[]',
    sourceFile,
    createdAt: now,
    updatedAt: now,
    indexedAt: now + 60_000,
    project: options.project,
    supersededBy: options.superseded ? '_test_superseded' : null,
    supersededAt: options.superseded ? now : null,
  }).run();
}

writeRepoFile(relAbsolute);
writeRepoFile(relBackslash);
writeRepoFile(relProjectFirst);
writeRepoFile(relCrew);
writeRepoFile(relProjectInbox);
writeRepoFile(relCrewInbox);
writeRepoFile(relRootInbox);
writeRepoFile(relLegacyProjectFirst);
seedDoc(ids.absolute, path.join(repoRoot, relAbsolute));
seedDoc(ids.backslash, relBackslash.replaceAll('/', '\\'));
seedDoc(ids.blank, '   ');
seedDoc(ids.orphanA, relOrphan.replaceAll('/', '\\'));
seedDoc(ids.orphanB, relOrphan);
seedDoc(ids.projectFirst, relProjectFirst);
seedDoc(ids.projectFirstOrphan, relProjectFirstOrphan);
seedDoc(ids.crew, relCrew);
seedDoc('verify-root-inbox', relRootInbox);
seedDoc('verify-legacy-flat', relLegacyFlat, { project: 'github.com/acme/demo' });
seedDoc('verify-superseded', `ψ/memory/learnings/verify-superseded-${stamp}.md`, { superseded: true });

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  dbModule.closeDb();
  restore('ORACLE_DATA_DIR', originalDataDir);
  restore('ORACLE_DB_PATH', originalDbPath);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('verifyKnowledgeBase edge cases', () => {
  test('normalizes absolute and backslash DB source paths before classification', () => {
    const result = verifyKnowledgeBase({ repoRoot, type: ' learning ' });

    expect(result.counts.healthy).toBe(6);
    expect(result.missing).toEqual([]);
    expect(result.orphaned).toEqual([relOrphan, relProjectFirstOrphan]);
    expect(result.orphaned).not.toContain('');
  });

  test('check=false flags every DB row for one normalized orphan path', () => {
    const result = verifyKnowledgeBase({ repoRoot, type: 'learning', check: false });
    const rows = db.select({ id: oracleDocuments.id, supersededBy: oracleDocuments.supersededBy })
      .from(oracleDocuments)
      .all();
    const superseded = Object.fromEntries(rows.map((row) => [row.id, row.supersededBy]));

    expect(result.fixedOrphans).toBe(3);
    expect(superseded[ids.orphanA]).toBe('_verified_orphan');
    expect(superseded[ids.orphanB]).toBe('_verified_orphan');
    expect(superseded[ids.projectFirstOrphan]).toBe('_verified_orphan');
    expect(superseded[ids.blank]).toBeNull();
  });

  test('classifies project-first vault files as healthy when file exists on disk', () => {
    const result = verifyKnowledgeBase({ repoRoot, type: 'learning' });

    expect(result.orphaned).not.toContain(relProjectFirst);
    expect(result.counts.healthy).toBeGreaterThanOrEqual(3);
  });

  test('classifies crew vault files as healthy when file exists on disk', () => {
    const result = verifyKnowledgeBase({ repoRoot, type: 'learning' });

    expect(result.orphaned).not.toContain(relCrew);
    expect(result.counts.healthy).toBeGreaterThanOrEqual(4);
  });

  test('reports project-first and crew inbox files as untracked', () => {
    const result = verifyKnowledgeBase({ repoRoot, type: 'learning' });

    expect(result.untracked).toContain(relProjectInbox);
    expect(result.untracked).toContain(relCrewInbox);
    expect(result.untracked).not.toContain(relRootInbox);
  });

  test('ignores superseded rows and resolves legacy flat paths to project-first files', () => {
    const result = verifyKnowledgeBase({ repoRoot, type: 'learning' });

    expect(result.orphaned).not.toContain(`ψ/memory/learnings/verify-superseded-${stamp}.md`);
    expect(result.orphaned).not.toContain(relLegacyFlat);
    expect(result.untracked).not.toContain(relRootInbox);
  });
});
