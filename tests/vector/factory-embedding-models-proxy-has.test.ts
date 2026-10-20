import { expect, test } from 'bun:test';
import { EMBEDDING_MODELS, getEmbeddingModels } from '../../src/vector/factory.ts';

// The proxy answers `in` for every enabled registry entry, and for nothing
// else. The key comes from the registry so the test holds in any deployment.
test('legacy embedding model proxy supports in-operator checks', () => {
  const models = getEmbeddingModels();
  for (const key of Object.keys(models)) {
    expect(key in EMBEDDING_MODELS).toBe(true);
  }
  expect('a-model-that-is-not-configured' in EMBEDDING_MODELS).toBe(false);
});
