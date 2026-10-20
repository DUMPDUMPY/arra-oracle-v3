/**
 * Canonical FTS5 bm25-rank normalization, shared by the HTTP search route
 * (server/handlers.ts, routes/search/tenant-search.ts) and the MCP/local search
 * tool (tools/search/*), so a document scores identically regardless of which
 * path serves the request.
 *
 * ROOT DEFECT (S1, HTTP seat): the HTTP-side `normalizeRank` used
 * `1 / (1 + |rank|)`, which maps the STRONGEST bm25 match (most-negative rank) to
 * the LOWEST score — so the fusion (which sorts by descending score) pushed an
 * exact/opaque marker to the BOTTOM and out of top-N. The MCP/local
 * `normalizeFtsScore` was already correct; this consolidates ONE monotonic-
 * increasing normalizer and points both HTTP copies at it.
 *
 * Ported from upstream PR #3029 (Soul-Brews-Studio/arra-oracle-v3), open and
 * unreviewed there when this was taken, with one deliberate difference: the
 * curve stays on the 0..1 scale instead of being banded into [0.9, 0.95].
 * The band exists to balance that PR's weighted fusion (0.5/0.5 over scores
 * that live on different scales); this branch's HTTP fusion adds a reciprocal
 * rank term to the same normalized score, and the downstream "strong keyword
 * score" signal thresholds at >= 0.7 — a banded score would clear that
 * threshold for every keyword hit and make the signal meaningless. The
 * upstream curve keeps both properties: monotonic in match strength, and a
 * weak match (|rank| = 1) below 0.7 while a strong one (|rank| >= 10) is above.
 */

/**
 * Normalize FTS5 bm25 `rank` (<= 0; more negative = better match) to a score in
 * [0, 1], **monotonically increasing in match strength** — a stronger match
 * scores HIGHER. (The HTTP copies were inverted.)
 */
export function normalizeRank(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  return 1 - Math.exp(-0.3 * Math.max(0, -rank));
}
