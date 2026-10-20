import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRank } from '../fts-rank.ts';

/**
 * The FTS5 bm25 rank is negative: more negative = a stronger match. Every
 * search path must turn that into a score that grows with match strength.
 *
 * The HTTP copies of the normalizer used `1 / (1 + |rank|)`, which mapped the
 * strongest match to the LOWEST score, so an exact keyword match sorted to the
 * bottom of the fused results and fell out of top-N (upstream #3029). The
 * normalizer now lives in one place; the guards below keep it that way.
 */
describe('normalizeRank', () => {
  test('grows with match strength', () => {
    expect(normalizeRank(-10)).toBeGreaterThan(normalizeRank(-5));
    expect(normalizeRank(-5)).toBeGreaterThan(normalizeRank(-1));
    expect(normalizeRank(-1)).toBeGreaterThan(normalizeRank(0));
  });

  test('stays inside 0..1', () => {
    for (let rank = -100; rank <= 0; rank++) {
      const score = normalizeRank(rank);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test('keeps a weak keyword match below the 0.7 "strong keyword score" threshold', () => {
    // The signal thresholds at >= 0.7, so a weak match must not clear it.
    expect(normalizeRank(-1)).toBeLessThan(0.7);
    expect(normalizeRank(-10)).toBeGreaterThanOrEqual(0.7);
  });

  test('is not the inverted curve', () => {
    // The inverted normalizer scored the strongest match lowest.
    expect(normalizeRank(-30)).toBeGreaterThan(normalizeRank(-0.1));
  });
});

describe('the HTTP search routes use the shared normalizer', () => {
  const repoRoot = path.resolve(import.meta.dir, '../../..');

  for (const file of ['src/server/handlers.ts', 'src/routes/search/tenant-search.ts']) {
    test(`${file} has no local inverted normalizer`, () => {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      expect(source).not.toMatch(/1\s*\/\s*\(1\s*\+\s*Math\.abs\(/);
      expect(source).toMatch(/from '\.\.\/(\.\.\/)?search\/fts-rank\.ts'/);
    });
  }
});
