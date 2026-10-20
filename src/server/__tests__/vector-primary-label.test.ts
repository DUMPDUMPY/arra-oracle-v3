import { afterAll, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-vector-primary-label-'));
const originalDataDir = process.env.ORACLE_DATA_DIR;
const originalDbPath = process.env.ORACLE_DB_PATH;
process.env.ORACLE_DATA_DIR = path.join(tmpRoot, 'data');
process.env.ORACLE_DB_PATH = path.join(tmpRoot, 'data', 'oracle.db');

const queried: string[] = [];
const models = {
  'bge-m3': { collection: 'oracle_knowledge_bge_m3', model: 'bge-m3', provider: 'ollama' },
  embeddinggemma2: {
    collection: 'oracle_knowledge_embeddinggemma2',
    model: 'embeddinggemma-2:270m',
    provider: 'ollama',
    primary: true,
  },
};

mock.module('../../vector/factory.ts', () => ({
  getEmbeddingModels: () => models,
  resolveModelKey: (model: string | undefined, registry: Record<string, any>) => resolveKey(model, registry),
  ensureVectorStoreConnected: async (model?: string) => fakeStore(resolveKey(model), queried),
  getVectorStoreConfigByModel: () => ({ type: 'lancedb' }),
  createVectorStore: () => fakeStore('', queried),
}));

const dbModule = await import('../../db/index.ts');
dbModule.resetDefaultDatabaseForTests(':memory:');
const { localVectorOperations } = await import('../vector-operations.ts');

test('the reported model is the collection that answered, not a historical default', async () => {
  const response = await localVectorOperations.search({ query: 'needle', limit: 3 });
  expect(queried).toEqual(['embeddinggemma2']);
  expect(response.results[0].model).toBe('embeddinggemma2');
});

afterAll(() => {
  try { dbModule.closeDb(); } catch {}
  if (originalDataDir !== undefined) process.env.ORACLE_DATA_DIR = originalDataDir;
  else delete process.env.ORACLE_DATA_DIR;
  if (originalDbPath !== undefined) process.env.ORACLE_DB_PATH = originalDbPath;
  else delete process.env.ORACLE_DB_PATH;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function resolveKey(model: string | undefined, registry: Record<string, any> = models): string {
  if (model && registry[model]) return model;
  const primary = Object.entries(registry).find(([, entry]: any) => entry.primary);
  if (primary) return primary[0];
  return Object.keys(registry)[0];
}

function fakeStore(name: string, seen: string[]) {
  return {
    name,
    getStats: async () => ({ count: 1 }),
    query: async () => {
      seen.push(name);
      return {
        ids: ['doc-1'],
        documents: ['needle document'],
        distances: [0.2],
        metadatas: [{ type: 'learning', source_file: 'ψ/learn/needle.md' }],
      };
    },
    connect: async () => {},
    close: async () => {},
  } as any;
}
