/**
 * The collection registry: which collections exist, which one is primary, and
 * the cached store per collection.
 *
 * The primary collection answers searches when no model is named, and the
 * registry can change while the process runs — so the MCP server resolves it
 * per tool call instead of capturing it at boot.
 */
import { configPath, loadVectorConfig, resolveServiceEndpoint, configToModels, fallbackCollectionsFor, generateDefaultConfig } from './config.ts';
import { resolveEmbeddingProviderType } from './embedder-config.ts';
import type { EmbeddingProviderType } from './types.ts';
import { createVectorStore, type EmbeddingModelConfig, type VectorStoreConfig } from './store-factory.ts';
import type { VectorStoreAdapter } from './adapter.ts';

function loadActiveVectorConfig(): ReturnType<typeof loadVectorConfig> {
  const dataDir = process.env.ORACLE_DATA_DIR;
  return loadVectorConfig(dataDir ? configPath(dataDir) : configPath());
}

export function getEmbeddingModels(
  cfg: ReturnType<typeof loadVectorConfig> = loadActiveVectorConfig(),
): Record<string, EmbeddingModelConfig> {
  const fallbackFromFallbackCollections = cfg ? fallbackCollectionsFor(cfg) : [];
  if (cfg && Object.keys(cfg.collections).length > 0) return configToModels(cfg);
  if (cfg && fallbackFromFallbackCollections.length > 0) {
    const modelMap: Record<string, EmbeddingModelConfig> = {};
    for (const col of fallbackFromFallbackCollections) {
      const serviceName = col.service;
      const storageService = serviceName ? cfg.storage?.services[serviceName] : undefined;
      modelMap[col.collection] = {
        collection: col.collection,
        model: col.model,
        adapter: storageService?.type === 'proxy' ? 'proxy' : col.adapter,
        endpoint: resolveServiceEndpoint(cfg, serviceName),
      };
    }
    return modelMap;
  }
  if (cfg) return configToModels(cfg);
  return configToModels(generateDefaultConfig());
}

export const EMBEDDING_MODELS = new Proxy({} as Record<string, EmbeddingModelConfig>, {
  get(_, prop: string) { return getEmbeddingModels()[prop]; },
  has(_, prop: string) { return prop in getEmbeddingModels(); },
  ownKeys() { return Object.keys(getEmbeddingModels()); },
  getOwnPropertyDescriptor(_, prop: string) {
    const models = getEmbeddingModels();
    if (prop in models) return { configurable: true, enumerable: true, value: models[prop] };
    return undefined;
  },
});

const modelStoreCache = new Map<string, VectorStoreAdapter>();
const connectPromises = new Map<string, Promise<void>>();

export function resolveModelKey(model: string | undefined, models: Record<string, EmbeddingModelConfig>): string {
  if (model && models[model]) return model;
  // The collection flagged primary in vector-server.json answers searches when
  // no model is named. Without that flag, fall back to bge-m3 and then to the
  // first registered model, which is the historical behaviour.
  const primary = Object.entries(models).find(([, entry]) => entry.primary);
  if (primary) return primary[0];
  if (models['bge-m3']) return 'bge-m3';
  const first = Object.keys(models)[0];
  if (!first) throw new Error('No embedding models configured');
  return first;
}

export function createVectorStoreForModel(preset: EmbeddingModelConfig): VectorStoreAdapter {
  return createVectorStore(vectorStoreConfigFromPreset(preset));
}

function vectorStoreConfigFromPreset(preset: EmbeddingModelConfig): VectorStoreConfig {
  return {
    type: preset.adapter || 'lancedb',
    collectionName: preset.collection,
    embeddingProvider: resolveEmbeddingProviderType(
      (preset.provider as EmbeddingProviderType | undefined) ?? preset.embedder?.backend,
    ),
    embeddingModel: preset.embedder?.model || preset.model,
    embeddingUrl: preset.embedder?.url,
    embeddingDimensions: preset.embedder?.dimensions,
    embeddingFallbackChain: preset.embedder?.fallbackChain
      ?? (preset.embedder?.fallback ? [preset.embedder.fallback] : undefined),
    proxyEndpoint: preset.endpoint,
    ...(preset.dataPath && { dataPath: preset.dataPath }),
    ...(preset.pythonVersion && { pythonVersion: preset.pythonVersion }),
    ...(preset.qdrantUrl && { qdrantUrl: preset.qdrantUrl }),
    ...(preset.qdrantApiKey && { qdrantApiKey: preset.qdrantApiKey }),
    ...(preset.cfAccountId && { cfAccountId: preset.cfAccountId }),
    ...(preset.cfApiToken && { cfApiToken: preset.cfApiToken }),
  };
}

export function getVectorStoreConfigByModel(
  model?: string,
  models = getEmbeddingModels(),
): VectorStoreConfig {
  const key = resolveModelKey(model, models);
  return vectorStoreConfigFromPreset(models[key]);
}

export function getVectorStoreByModel(
  model?: string,
  models = getEmbeddingModels(),
  connectStore: (store: VectorStoreAdapter) => Promise<void> = (store) => store.connect(),
): VectorStoreAdapter {
  const key = resolveModelKey(model, models);
  let store = modelStoreCache.get(key);
  if (!store) {
    const preset = models[key];
    store = createVectorStoreForModel(preset);
    modelStoreCache.set(key, store);
    const newStore = store;
    connectPromises.set(key, Promise.resolve().then(() => connectStore(newStore)).catch(e =>
      console.warn(`[VectorRegistry] Failed to connect ${key}:`, e instanceof Error ? e.message : String(e))
    ));
  }
  return store;
}

export async function ensureVectorStoreConnected(
  model?: string,
  models = getEmbeddingModels(),
): Promise<VectorStoreAdapter> {
  const key = resolveModelKey(model, models);
  const store = getVectorStoreByModel(model, models);
  const pending = connectPromises.get(key);
  if (pending) await pending;
  return store;
}

export async function closeCachedVectorStores(): Promise<void> {
  const stores = [...modelStoreCache.values()];
  modelStoreCache.clear(); connectPromises.clear();
  await Promise.all(stores.map((store) => store.close().catch((e) =>
    console.warn(`[VectorRegistry] Failed to close ${store.name}:`, e instanceof Error ? e.message : String(e))
  )));
}

export async function reloadCachedVectorStores(
  models = getEmbeddingModels(),
  connectStore: (store: VectorStoreAdapter) => Promise<void> = (store) => store.connect(),
): Promise<{ reloaded: number }> {
  const keys = [...modelStoreCache.keys()];
  await closeCachedVectorStores();
  const reloadKeys = keys.filter((key) => key in models);
  await Promise.all(reloadKeys.map(async (key) => {
    const store = getVectorStoreByModel(key, models, connectStore);
    const pending = connectPromises.get(key);
    if (pending) await pending;
    return store;
  }));
  return { reloaded: reloadKeys.length };
}
