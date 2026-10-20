import { expect, test } from 'bun:test';
import { EMBEDDING_MODELS, getEmbeddingModels } from '../../src/vector/factory.ts';

// The proxy exposes the models the registry has enabled, whichever those are.
// Hardcoding a model name here broke the moment a deployment switched its
// primary collection, so the assertion follows the registry instead.
test('legacy embedding model proxy resolves model properties lazily', () => {
  const models = getEmbeddingModels();
  const key = Object.keys(models)[0];
  if (!key) {
    expect(Object.keys(EMBEDDING_MODELS)).toEqual([]);
    return;
  }
  expect(EMBEDDING_MODELS[key].model).toBe(models[key].model);
  expect(EMBEDDING_MODELS[key].collection).toBe(models[key].collection);
});
