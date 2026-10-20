import { afterEach, describe, expect, it } from 'bun:test';
import { OllamaEmbeddings } from '../embeddings.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureRequests(): { requests: Array<{ model: string; input: string[] }> } {
  const requests: Array<{ model: string; input: string[] }> = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    requests.push(body);
    return Response.json({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) });
  }) as typeof fetch;
  return { requests };
}

describe('OllamaEmbeddings instruction prefixes', () => {
  it('prefixes EmbeddingGemma queries with the search-result task', async () => {
    const { requests } = captureRequests();
    const embedder = new OllamaEmbeddings({ model: 'embeddinggemma-2:270m' });

    await embedder.embed(['how does reindex work'], 'query');

    expect(requests[0].input).toEqual(['task: search result | query: how does reindex work']);
  });

  it('prefixes EmbeddingGemma passages with the document task', async () => {
    const { requests } = captureRequests();
    const embedder = new OllamaEmbeddings({ model: 'embeddinggemma-2:270m' });

    await embedder.embed(['the reindex pipeline reconciles sqlite'], 'passage');

    expect(requests[0].input).toEqual(['title: none | text: the reindex pipeline reconciles sqlite']);
  });

  it('keeps the bge-m3 prefixes unchanged', async () => {
    const { requests } = captureRequests();
    const embedder = new OllamaEmbeddings({ model: 'bge-m3' });

    await embedder.embed(['hello'], 'query');
    await embedder.embed(['world'], 'passage');

    expect(requests[0].input).toEqual(['query: hello']);
    expect(requests[1].input).toEqual(['passage: world']);
  });

  it('leaves models without a retrieval prefix untouched', async () => {
    const { requests } = captureRequests();
    const embedder = new OllamaEmbeddings({ model: 'nomic-embed-text' });

    await embedder.embed(['hello'], 'query');
    await embedder.embed(['world'], 'passage');

    expect(requests[0].input).toEqual(['hello']);
    expect(requests[1].input).toEqual(['world']);
  });

  it('reports 768 dimensions for EmbeddingGemma before the first response', () => {
    const embedder = new OllamaEmbeddings({ model: 'embeddinggemma-2:270m' });
    expect(embedder.dimensions).toBe(768);
  });

  it('truncates to 2000 characters after prefixing', async () => {
    const { requests } = captureRequests();
    const embedder = new OllamaEmbeddings({ model: 'embeddinggemma-2:270m' });
    const long = 'x'.repeat(5000);

    await embedder.embed([long], 'query');

    const sent = requests[0].input[0];
    expect(sent.startsWith('task: search result | query: ')).toBe(true);
    expect(sent.length).toBe('task: search result | query: '.length + 2000);
  });
});
