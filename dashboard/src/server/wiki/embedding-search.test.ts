import { describe, expect, it, vi } from 'vitest';
import { mapVectorResultsToParents, vectorSearch, type EmbeddingIndex, type VectorSearchResult } from './embedding.js';
import { buildSearchFragments } from './structured-fragments.js';

/** Independent pre-optimization oracle: full cosine scan, stable sort, then slice. */
function referenceSearch(
  query: Float32Array,
  index: EmbeddingIndex,
  limit: number,
  allowed?: ReadonlySet<string>,
): VectorSearchResult[] {
  const results: VectorSearchResult[] = [];
  for (let slot = 0; slot < index.docIds.length; slot++) {
    if (allowed && !allowed.has(index.chunkDocIds?.[slot] ?? index.docIds[slot])) continue;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < query.length; i++) {
      dot += query[i] * index.vectors[slot][i];
      normA += query[i] * query[i];
      normB += index.vectors[slot][i] * index.vectors[slot][i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    const score = denominator === 0 ? 0 : dot / denominator;
    if (score > 0) results.push({
      docId: index.docIds[slot],
      score,
      ...(index.fragments?.[slot] ? { fragment: index.fragments[slot] } : {}),
    });
  }
  return results.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId)).slice(0, limit);
}

function makeIndex(vectors: number[][], docIds = vectors.map((_, i) => `doc-${i}`)): EmbeddingIndex {
  return { modelId: 'test-only', dimension: vectors[0]?.length ?? 2, docIds, vectors: vectors.map(v => new Float32Array(v)), builtAt: 0 };
}

function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

describe('flat vector search exact selection', () => {
  it('matches full-sort IDs, exact scores, and stable ties across deterministic random corpora', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const next = random(seed);
      const dimension = 1 + seed % 17;
      const count = 40 + seed * 7;
      const query = Float32Array.from({ length: dimension }, () => next() * 2 - 1);
      const index = makeIndex(Array.from({ length: count }, () =>
        Array.from({ length: dimension }, () => next() * 2 - 1)));
      // Include exact ties and collation-equivalent IDs to exercise stable selection.
      index.vectors[1] = index.vectors[0].slice();
      index.vectors[2] = index.vectors[0].slice();
      index.docIds[0] = 'é';
      index.docIds[1] = 'e\u0301';
      index.docIds[2] = 'é';
      index.chunkDocIds = index.docIds.map((_, i) => `parent-${i % 7}`);
      for (const allowed of [undefined, new Set(['parent-1', 'parent-4']), new Set<string>()]) {
        for (const limit of [1, 2, 7, 20, count, count + 10]) {
          expect(vectorSearch(query, index, limit, allowed)).toEqual(referenceSearch(query, index, limit, allowed));
        }
      }
    }
  });

  it('retains Array.slice limit behavior for exported legacy callers', () => {
    const index = makeIndex([[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]]);
    const query = new Float32Array([1, 0]);
    for (const limit of [0, -0, -1, -2, -100, 0.5, 1.9, -1.9, NaN, Infinity, -Infinity]) {
      expect(vectorSearch(query, index, limit)).toEqual(referenceSearch(query, index, limit));
    }
  });

  it('filters by parent before selection without collapsing raw fragment candidates', () => {
    const fragments = buildSearchFragments({ id: 'allowed', title: 'Allowed', body: '# A\nfirst\n# B\nsecond' });
    const index = makeIndex([[1, 0], [0.8, 0.2], [0.7, 0.3]], ['denied#0', ...fragments.map(f => f.fragmentId)]);
    index.chunkDocIds = ['denied', 'allowed', 'allowed'];
    index.fragments = [undefined!, ...fragments];
    const query = new Float32Array([1, 0]);
    const results = vectorSearch(query, index, 2, new Set(['allowed']));
    expect(results).toEqual(referenceSearch(query, index, 2, new Set(['allowed'])));
    expect(results.map(r => r.docId)).toEqual(fragments.map(f => f.fragmentId));
    expect(results[0].fragment).toBe(fragments[0]);
    expect(mapVectorResultsToParents(results, index)).toEqual([{ docId: 'allowed', score: results[0].score, fragment: fragments[0] }]);
  });

  it('uses raw doc IDs when no chunk parent mapping exists', () => {
    const index = makeIndex([[1, 0], [0.5, 0.5]], ['denied', 'allowed']);
    expect(vectorSearch(new Float32Array([1, 0]), index, 1, new Set(['allowed']))[0].docId).toBe('allowed');
  });

  it('keeps original evidence when equal scores and locale comparisons tie', () => {
    const fragments = buildSearchFragments({ id: 'parent', title: 'Parent', body: '# A\nfirst\n# B\nsecond' });
    const index = makeIndex([[1, 0], [1, 0]], ['é', 'e\u0301']);
    index.fragments = fragments;
    expect(index.docIds[0].localeCompare(index.docIds[1])).toBe(0);
    const result = vectorSearch(new Float32Array([1, 0]), index, 1);
    expect(result).toEqual(referenceSearch(new Float32Array([1, 0]), index, 1));
    expect(result[0].fragment).toBe(fragments[0]);
  });

  it('excludes zero, negative, NaN and infinite cosine results and handles ragged vectors as before', () => {
    const index = makeIndex([[0, 0], [-1, 0], [0, 1], [NaN, 1], [Infinity, 1], [1], [1, 0, 9], [1, 1]]);
    for (const query of [new Float32Array([1, 0]), new Float32Array([0, 0]), new Float32Array([NaN, 0]), new Float32Array([Infinity, 0])]) {
      for (const limit of [1, 3, 20]) expect(vectorSearch(query, index, limit)).toEqual(referenceSearch(query, index, limit));
    }
  });

  it('reads mutable query/document vectors afresh rather than caching stale norms', () => {
    const query = new Float32Array([1, 0]);
    const index = makeIndex([[1, 0], [0.5, 0.5]]);
    vectorSearch(query, index, 1);
    query[1] = 2;
    index.vectors[0][1] = -2;
    expect(vectorSearch(query, index, 1)).toEqual(referenceSearch(query, index, 1));
  });

  it('handles empty indexes and preserves dimension mismatch fallback', () => {
    expect(vectorSearch(new Float32Array([1, 0]), makeIndex([]), 10)).toEqual([]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(vectorSearch(new Float32Array([1]), makeIndex([[1, 0]]), 1)).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('dimension mismatch'));
    } finally {
      error.mockRestore();
    }
  });
});
