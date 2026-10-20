/**
 * Row-level storage for the learning CRUD routes.
 *
 * The route handlers own HTTP concerns; identity, file writes and the FTS
 * mirror live here so both the create and the update path agree on how a
 * learning is named, where it lands and what the index sees.
 */
import fs from 'fs';
import path from 'path';
import { and, eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { db, oracleDocuments } from '../../db/index.ts';
import { currentTenantId } from '../../middleware/tenant.ts';
import { conceptsFrom, slugFor } from './content.ts';
import {
  INVALID_LEARNING_SOURCE_FILE,
  learningSourcePath,
} from './safety.ts';

export type LearnDoc = typeof oracleDocuments.$inferSelect;

export const oracleFts = sqliteTable('oracle_fts', {
  id: text('id'),
  content: text('content'),
  concepts: text('concepts'),
});

export function writeLearningFile(sourceFile: string, content: string): boolean {
  const filePath = learningSourcePath(sourceFile);
  if (!filePath) throw new Error(INVALID_LEARNING_SOURCE_FILE);
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

export function ftsContent(id: string): string | null {
  return db.select({ content: oracleFts.content })
    .from(oracleFts)
    .where(eq(oracleFts.id, id))
    .get()?.content ?? null;
}

export function upsertFts(id: string, content: string, concepts: string[]): void {
  db.delete(oracleFts).where(eq(oracleFts.id, id)).run();
  db.insert(oracleFts).values({ id, content, concepts: concepts.join(' ') }).run();
}

export function nextIdentity(pattern: string, requestedId?: string, requestedSourceFile?: string) {
  if (requestedId) {
    return {
      id: requestedId,
      sourceFile: requestedSourceFile ?? `ψ/memory/learnings/${requestedId}.md`,
    };
  }
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugFor(pattern);
  let suffix = 1;
  while (true) {
    const tail = suffix === 1 ? slug : `${slug}-${suffix}`;
    const id = `learning_${date}_${tail}`;
    const sourceFile = requestedSourceFile ?? `ψ/memory/learnings/${date}_${tail}.md`;
    const tenantId = currentTenantId();
    const where = tenantId ? and(eq(oracleDocuments.id, id), eq(oracleDocuments.tenantId, tenantId)) : eq(oracleDocuments.id, id);
    const existing = db.select({ id: oracleDocuments.id })
      .from(oracleDocuments)
      .where(where)
      .get();
    const filePath = learningSourcePath(sourceFile);
    if (!existing && filePath && !fs.existsSync(filePath)) {
      return {
        id,
        sourceFile,
      };
    }
    suffix += 1;
  }
}

export function rowById(id: string): LearnDoc | undefined {
  const tenantId = currentTenantId();
  const base = and(eq(oracleDocuments.id, id), eq(oracleDocuments.type, 'learning'));
  return db.select().from(oracleDocuments)
    .where(tenantId ? and(base, eq(oracleDocuments.tenantId, tenantId)) : base)
    .get();
}

export function responseRow(row: LearnDoc) {
  return { ...row, concepts: conceptsFrom(row.concepts) };
}
