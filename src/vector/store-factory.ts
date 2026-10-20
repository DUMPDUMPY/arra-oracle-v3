/**
 * Store construction: the adapter for a given vector DB type, and the
 * embedder wired into it.
 *
 * The registry (which collection answers searches) lives in ./registry.ts.
 */
import { VECTORS_DB_PATH, LANCEDB_DIR, CHROMADB_DIR } from '../config.ts';
import { COLLECTION_NAME } from '../const.ts';
import type { VectorStoreAdapter } from './adapter.ts';
import type { EmbedderConfig, VectorDBType, EmbeddingProviderType, EmbeddingProvider } from './types.ts';
import { ChromaMcpAdapter } from './adapters/chroma-mcp.ts';
import { SqliteVecAdapter } from './adapters/sqlite-vec.ts';
import { LanceDBAdapter } from './adapters/lancedb.ts';
import { QdrantAdapter } from './adapters/qdrant.ts';
import { createCloudflareVectorStore, type CloudflareAIWorkerBinding, type CloudflareD1Database, type CloudflareVectorizeBinding } from './adapters/cloudflare.ts';
import { ProxyVectorAdapter } from './adapters/proxy.ts';
import { requireVectorProxyContract } from './proxy-contract.ts';
import { TurboVecAdapter } from './adapters/turbovec.ts';
import { createEmbeddingProvider, FallbackEmbeddings } from './embeddings.ts';
import { GeminiEmbeddings } from './providers/gemini.ts';
import { observeEmbeddingProvider, resolveEmbeddingFallbackChain, resolveEmbeddingModel, resolveEmbeddingProviderSelection, resolveEmbeddingProviderType } from './embedder-config.ts';
import { tenantDataPath } from '../middleware/tenant.ts';
import { withEmbedderIdentityGuard } from './embedder-identity.ts';

export type { VectorStoreAdapter } from './adapter.ts';

export interface VectorStoreConfig {
  type?: VectorDBType;
  collectionName?: string;
  dataPath?: string;
  pythonVersion?: string;
  embeddingProvider?: EmbeddingProviderType;
  embeddingModel?: string;
  embeddingUrl?: string;
  embeddingDimensions?: number;
  embeddingFallbackChain?: EmbeddingProviderType[];
  qdrantUrl?: string;
  qdrantApiKey?: string;
  cfAccountId?: string;
  cfApiToken?: string;
  cfAi?: CloudflareAIWorkerBinding;
  cfVectorize?: CloudflareVectorizeBinding;
  cfD1?: CloudflareD1Database;
  cfD1Table?: string;
  proxyEndpoint?: string;
}

export interface EmbeddingModelConfig {
  collection: string; model: string; adapter?: VectorDBType; dataPath?: string; embedder?: EmbedderConfig;
  provider?: string; endpoint?: string; pythonVersion?: string; qdrantUrl?: string; qdrantApiKey?: string;
  cfAccountId?: string; cfApiToken?: string;
  /** The collection that answers searches when no model is named. */
  primary?: boolean;
}

export function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function createConfiguredEmbedder(config: VectorStoreConfig) {
  const selection = resolveEmbeddingProviderSelection(config.embeddingProvider ?? (config.embeddingModel ? 'ollama' : undefined));
  const provider = selection.provider;
  const model = resolveEmbeddingModel(config.embeddingModel);
  const fallbackChain = resolveEmbeddingFallbackChain(config.embeddingFallbackChain);
  const options = { url: config.embeddingUrl, dimensions: config.embeddingDimensions, fallbackChain };
  const observe = (embedder: EmbeddingProvider) => observeEmbeddingProvider(embedder, selection);
  const chain = [provider, ...fallbackChain].filter((item, index, all) =>
    item !== 'none' && all.indexOf(item) === index
  );
  if (chain.length > 1 && chain.includes('gemini')) {
    const singleOptions = { url: config.embeddingUrl, dimensions: config.embeddingDimensions };
    return observe(new FallbackEmbeddings(chain.map((item) => item === 'gemini'
      ? new GeminiEmbeddings({ model })
      : createEmbeddingProvider(item, model, singleOptions))));
  }
  if (provider === 'gemini' && fallbackChain.length === 0) return observe(new GeminiEmbeddings({ model }));
  return observe(createEmbeddingProvider(provider, model, options));
}

export function createVectorStore(config: VectorStoreConfig = {}): VectorStoreAdapter {
  const type = (clean(config.type) || clean(process.env.ORACLE_VECTOR_DB) || 'lancedb').toLowerCase() as VectorDBType;
  const collectionName = clean(config.collectionName) || COLLECTION_NAME;
  switch (type) {
    case 'sqlite-vec': {
      const dbPath = tenantDataPath(clean(config.dataPath) || clean(process.env.ORACLE_VECTOR_DB_PATH) || VECTORS_DB_PATH);
      const embedder = createConfiguredEmbedder(config);
      return guardVectorStore(new SqliteVecAdapter(collectionName, dbPath, embedder), type, collectionName, embedder, dbPath, config.embeddingModel);
    }
    case 'lancedb': {
      const dbPath = tenantDataPath(clean(config.dataPath) || clean(process.env.ORACLE_VECTOR_DB_PATH) || LANCEDB_DIR);
      const embedder = createConfiguredEmbedder(config);
      return guardVectorStore(new LanceDBAdapter(collectionName, dbPath, embedder), type, collectionName, embedder, dbPath, config.embeddingModel);
    }
    case 'qdrant': {
      const embedder = createConfiguredEmbedder(config);
      return guardVectorStore(new QdrantAdapter(collectionName, embedder, {
        url: clean(config.qdrantUrl) || clean(process.env.QDRANT_URL),
        apiKey: clean(config.qdrantApiKey) || clean(process.env.QDRANT_API_KEY),
      }), type, collectionName, embedder, clean(config.qdrantUrl) || clean(process.env.QDRANT_URL), config.embeddingModel);
    }
    case 'cloudflare-vectorize': {
      return createCloudflareVectorStore(collectionName, config);
    }
    case 'proxy': {
      const contract = requireVectorProxyContract({
        endpoint: config.proxyEndpoint,
        collectionName,
        backend: config.type,
      });
      return new ProxyVectorAdapter(collectionName, contract.baseUrl, contract.timeoutMs);
    }
    case 'turbovec': {
      return new TurboVecAdapter(collectionName, clean(config.proxyEndpoint));
    }
    case 'chroma':
    default: {
      const dataPath = tenantDataPath(clean(config.dataPath) || CHROMADB_DIR);
      const pythonVersion = clean(config.pythonVersion) || '3.12';
      return new ChromaMcpAdapter(collectionName, dataPath, pythonVersion);
    }
  }
}

function guardVectorStore<T extends VectorStoreAdapter>(
  store: T, adapterName: VectorDBType, collectionName: string, embedder: EmbeddingProvider,
  storagePath?: string, modelName?: string,
): T {
  return withEmbedderIdentityGuard(store, {
    adapterName,
    collectionName,
    embedder,
    modelName: resolveEmbeddingModel(modelName),
    storagePath,
  });
}
