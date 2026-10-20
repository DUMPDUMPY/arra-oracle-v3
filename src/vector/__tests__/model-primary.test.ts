import { describe, expect, it } from 'bun:test';
import { getVectorStoreConfigByModel } from '../factory.ts';

const models = {
  'bge-m3': { collection: 'oracle_knowledge_bge_m3', model: 'bge-m3', provider: 'ollama' },
  embeddinggemma2: {
    collection: 'oracle_knowledge_embeddinggemma2',
    model: 'embeddinggemma-2:270m',
    provider: 'ollama',
  },
} as any;

describe('model key resolution', () => {
  it('uses the collection flagged primary when no model is named', () => {
    const withPrimary = { ...models, embeddinggemma2: { ...models.embeddinggemma2, primary: true } };
    const config = getVectorStoreConfigByModel(undefined, withPrimary);
    expect(config.collectionName).toBe('oracle_knowledge_embeddinggemma2');
    expect(config.embeddingModel).toBe('embeddinggemma-2:270m');
  });

  it('still honours an explicitly named model', () => {
    const withPrimary = { ...models, embeddinggemma2: { ...models.embeddinggemma2, primary: true } };
    const config = getVectorStoreConfigByModel('bge-m3', withPrimary);
    expect(config.collectionName).toBe('oracle_knowledge_bge_m3');
  });

  it('falls back to bge-m3 when no collection is flagged primary', () => {
    const config = getVectorStoreConfigByModel(undefined, models);
    expect(config.collectionName).toBe('oracle_knowledge_bge_m3');
  });

  it('falls back to the first registered model when bge-m3 is not registered', () => {
    const { 'bge-m3': _bge, ...withoutBge } = models;
    const config = getVectorStoreConfigByModel(undefined, withoutBge);
    expect(config.collectionName).toBe('oracle_knowledge_embeddinggemma2');
  });
});
