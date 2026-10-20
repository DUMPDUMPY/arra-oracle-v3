import { afterEach, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/index.ts';
import {
  clearEmbedderRuntimeStatusForTests,
  setEmbedderRuntimeStatus,
} from '../../src/vector/embedder-config.ts';
import { resolveModelKey } from '../../src/vector/factory.ts';
import { OracleMCPServer } from '../../src/mcp/server.ts';
import { allToolGroups, callToolHandler } from './support/server.ts';

const saved = {
  httpUrl: process.env.ORACLE_HTTP_URL,
  vectorEnabled: process.env.ORACLE_VECTOR_ENABLED,
  rerankerUrl: process.env.ORACLE_RERANKER_URL,
};

afterEach(() => {
  restore('ORACLE_HTTP_URL', saved.httpUrl);
  restore('ORACLE_VECTOR_ENABLED', saved.vectorEnabled);
  restore('ORACLE_RERANKER_URL', saved.rerankerUrl);
  clearEmbedderRuntimeStatusForTests();
});

test('MCP searches the primary collection and labels the model that answered', async () => {
  process.env.ORACLE_HTTP_URL = '';
  process.env.ORACLE_VECTOR_ENABLED = '1';
  delete process.env.ORACLE_RERANKER_URL;
  const connection = createDatabase(':memory:');
  const queried: string[] = [];
  const models = {
    'bge-m3': { collection: 'oracle_knowledge', model: 'bge-m3', provider: 'ollama' },
    embeddinggemma2: {
      collection: 'oracle_knowledge_embeddinggemma2',
      model: 'embeddinggemma-2:270m',
      provider: 'ollama',
      primary: true,
    },
  };
  const server = new OracleMCPServer({
    toolGroups: allToolGroups,
    embeddedDeps: {
      createVectorStoreForModel: (preset: any) => fakeStore(preset.collection, queried),
      getEmbeddingModels: () => models,
      getVectorStoreByModel: (model?: string) => fakeStore(model ?? '', queried),
      ensureVectorStoreConnected: async (model?: string) => fakeStore(model ?? '', queried),
      resolveModelKey,
      createDatabase: () => connection,
      probeEmbedder: async () => ({
        status: 'connected', provider: 'ollama', source: 'auto-default', explicit: false,
        checkedAt: new Date().toISOString(),
      }),
    },
  });
  try {
    markEmbedderConnected();
    const search = await toolJson(server, 'oracle_search', { query: 'needle', mode: 'vector', limit: 3 });
    expect(queried).toEqual(['embeddinggemma2']);
    expect(search.results[0].model).toBe('embeddinggemma2');
  } finally {
    await server.cleanup();
  }
});

test('MCP follows a registry switch to another collection without a restart', async () => {
  process.env.ORACLE_HTTP_URL = '';
  process.env.ORACLE_VECTOR_ENABLED = '1';
  delete process.env.ORACLE_RERANKER_URL;
  const connection = createDatabase(':memory:');
  const queried: string[] = [];
  const models: Record<string, any> = {
    'bge-m3': { collection: 'oracle_knowledge', model: 'bge-m3', provider: 'ollama' },
    embeddinggemma2: {
      collection: 'oracle_knowledge_embeddinggemma2',
      model: 'embeddinggemma-2:270m',
      provider: 'ollama',
      primary: true,
    },
  };
  const server = new OracleMCPServer({
    toolGroups: allToolGroups,
    embeddedDeps: {
      createVectorStoreForModel: (preset: any) => fakeStore(preset.collection, queried),
      getEmbeddingModels: () => models,
      getVectorStoreByModel: (model?: string) => fakeStore(model ?? '', queried),
      ensureVectorStoreConnected: async (model?: string) => fakeStore(model ?? '', queried),
      resolveModelKey,
      createDatabase: () => connection,
      probeEmbedder: async () => ({
        status: 'connected', provider: 'ollama', source: 'auto-default', explicit: false,
        checkedAt: new Date().toISOString(),
      }),
    },
  });
  try {
    markEmbedderConnected();
    await toolJson(server, 'oracle_search', { query: 'needle', mode: 'vector', limit: 3 });
    expect(queried).toEqual(['embeddinggemma2']);

    // The registry promotes another model while the server keeps running.
    models['bge-m3'].primary = true;
    delete models.embeddinggemma2.primary;

    markEmbedderConnected();
    const search = await toolJson(server, 'oracle_search', { query: 'needle', mode: 'vector', limit: 3 });
    expect(queried).toEqual(['embeddinggemma2', 'bge-m3']);
    expect(search.results[0].model).toBe('bge-m3');
  } finally {
    await server.cleanup();
  }
});

function markEmbedderConnected(): void {
  setEmbedderRuntimeStatus({
    status: 'connected', provider: 'ollama', source: 'auto-default', explicit: false,
    checkedAt: new Date().toISOString(),
  });
}

async function toolJson(server: OracleMCPServer, name: string, args: Record<string, unknown>) {
  const response = await callToolHandler(server)({ params: { name, arguments: args } });
  expect(response.isError).toBeUndefined();
  return JSON.parse(response.content[0].text);
}

function fakeStore(name: string, queried: string[]) {
  return {
    name,
    getStats: async () => ({ count: 1 }),
    query: async () => {
      queried.push(name);
      return {
        ids: ['doc-1'],
        documents: ['needle document'],
        distances: [0.2],
        metadatas: [{ type: 'learning', source_file: 'ψ/learn/needle.md', concepts: '[]' }],
      };
    },
    connect: async () => {},
    close: async () => {},
  } as any;
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
