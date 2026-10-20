/**
 * Public surface of the vector layer.
 *
 * Store construction lives in ./store-factory.ts, the collection registry in
 * ./collection-registry.ts. This file stays the import surface every caller uses.
 */
export type { VectorStoreAdapter } from './adapter.ts';
export type { VectorStoreConfig, EmbeddingModelConfig } from './store-factory.ts';
export { createVectorStore } from './store-factory.ts';
export {
  EMBEDDING_MODELS,
  closeCachedVectorStores,
  createVectorStoreForModel,
  ensureVectorStoreConnected,
  getEmbeddingModels,
  getVectorStoreByModel,
  getVectorStoreConfigByModel,
  reloadCachedVectorStores,
  resolveModelKey,
} from './collection-registry.ts';
