import { getEmbeddingModels } from '../../vector/factory.ts';

/**
 * The searchable collections come from the registry, so the schema lists the
 * collections that exist right now instead of a frozen list of model names.
 */
export function vectorModelKeys(): string[] {
  const keys = Object.keys(getEmbeddingModels());
  return keys.length > 0 ? keys : ['bge-m3'];
}

export const searchToolDef = {
  name: 'oracle_search',
  description: 'Search Oracle knowledge base using hybrid search (FTS5 keywords + LanceDB vectors). Finds relevant principles, patterns, learnings, or retrospectives. Falls back to FTS5-only if the vector index is unavailable.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g., "nothing deleted", "force push safety")',
      },
      type: {
        type: 'string',
        enum: ['principle', 'pattern', 'learning', 'retro', 'all'],
        description: 'Filter by document type',
        default: 'all',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results',
        default: 5,
      },
      offset: {
        type: 'number',
        description: 'Number of results to skip (for pagination)',
        default: 0,
      },
      mode: {
        type: 'string',
        enum: ['hybrid', 'fts', 'vector'],
        description: 'Search mode: hybrid (default), fts (keywords only), vector (semantic only)',
        default: 'hybrid',
      },
      retrieval: {
        type: 'string',
        enum: ['full', 'compact-summary'],
        description: 'Result payload size: full returns normal result content, compact-summary returns query-aware distilled snippets for token economy',
        default: 'full',
      },
      project: {
        type: 'string',
        description: 'Filter by project (e.g., "github.com/owner/repo"). Returns project + universal results.',
      },
      cwd: {
        type: 'string',
        description: 'Auto-detect project from working directory path (follows symlinks to ghq paths)',
      },
      model: {
        type: 'string',
        enum: vectorModelKeys(),
        description: 'Embedding collection to search. Omit to search the primary collection from vector-server.json.',
      },
      asOf: {
        type: 'string',
        description: 'Valid-time timestamp for historical search, e.g. 2026-06-17T00:00:00Z',
      },
    },
    required: ['query'],
  },
};
