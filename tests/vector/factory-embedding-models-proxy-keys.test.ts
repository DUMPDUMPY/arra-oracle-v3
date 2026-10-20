import { expect, test } from 'bun:test';
import { EMBEDDING_MODELS, getEmbeddingModels } from '../../src/vector/factory.ts';

// The proxy enumerates the enabled registry entries. Naming one model here
// broke the moment a deployment switched its primary collection.
test('legacy embedding model proxy enumerates configured model keys', () => {
  const keys = Object.keys(getEmbeddingModels());
  expect(Object.keys(EMBEDDING_MODELS).sort()).toEqual(keys.sort());
});
