import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { currentDbRequestId, type DbQueryObserver } from '../middleware/db-context.ts';

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  who: text('who').notNull(),
  what: text('what').notNull(),
  when: integer('when').notNull(),
  requestId: text('request_id'),
}, (table) => [
  index('idx_audit_log_when').on(table.when),
  index('idx_audit_log_request').on(table.requestId),
  index('idx_audit_log_who').on(table.who),
]);

export type AuditLogSchema = { auditLog: typeof auditLog };
export type AuditLogDatabase = BunSQLiteDatabase<AuditLogSchema>;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type AuditLogOptions = {
  actor?: () => string | undefined;
  now?: () => number;
};

const writeOperations = new Set(['insert', 'update', 'delete', 'replace']);

export function normalizeAuditQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function stripLeadingSqlComments(query: string): string {
  let remaining = query.trimStart();
  while (remaining.startsWith('--') || remaining.startsWith('/*')) {
    if (remaining.startsWith('--')) {
      const nextLine = remaining.indexOf('\n');
      remaining = nextLine === -1 ? '' : remaining.slice(nextLine + 1).trimStart();
      continue;
    }
    const commentEnd = remaining.indexOf('*/');
    if (commentEnd === -1) return '';
    remaining = remaining.slice(commentEnd + 2).trimStart();
  }
  return remaining;
}

function writeStatementHead(query: string): string {
  return normalizeAuditQuery(stripLeadingSqlComments(query))
    .toLowerCase()
    .replace(/^with\b[\s\S]*\)\s+(?=(insert|update|delete|replace)\b)/, '');
}

function firstQueryToken(query: string): string {
  return writeStatementHead(query).split(' ', 1)[0] ?? '';
}

export function isWriteQuery(query: string): boolean {
  return writeOperations.has(firstQueryToken(query));
}

export function isAuditLogQuery(query: string): boolean {
  const normalized = writeStatementHead(query).replace(/["`\[\]]/g, '');
  const auditTable = '(?:[a-z_][\\w]*\\.)?audit_log\\b';
  return new RegExp(`^(insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into)\\s+${auditTable}`)
    .test(normalized)
    || new RegExp(`^update\\s+${auditTable}`).test(normalized)
    || new RegExp(`^delete\\s+from\\s+${auditTable}`).test(normalized);
}

function defaultActor(requestId?: string): string {
  return requestId ? 'http' : 'system';
}

export function createAuditLogObserver(
  db: AuditLogDatabase,
  options: AuditLogOptions = {},
): DbQueryObserver {
  return (query) => {
    if (!isWriteQuery(query) || isAuditLogQuery(query)) return;

    const requestId = currentDbRequestId();
    // LOCAL PATCH 2026-08-19 (deploy/alpha, not upstream): skip writes that have
    // no request context (indexer CLI / daemon / background jobs). The full
    // reindex rewrites ~3k chunks 4x/day, which produced ~9k audit rows per run
    // and grew audit_log to 1.08M rows / ~290MB in 6 weeks (DB 425MB), pushing
    // reindex runtime past its 600s timeout (cron exit 124, 5 consecutive runs).
    // Auditing only request-scoped writes matches the upstream feature intent:
    // "Audit DB writes with request context" (#1562).
    if (!requestId) return;
    db.insert(auditLog).values({
      who: options.actor?.() ?? defaultActor(requestId),
      what: normalizeAuditQuery(query),
      when: options.now?.() ?? Date.now(),
      requestId,
    }).run();
  };
}
