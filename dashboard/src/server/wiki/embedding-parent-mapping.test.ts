import { describe, expect, it } from 'vitest';
import { mapVectorResultsToParents, type EmbeddingIndex, type VectorSearchResult } from './embedding.js';
import type { SearchFragment } from './structured-fragments.js';

type MappingIndex = Pick<EmbeddingIndex, 'docIds' | 'chunkDocIds' | 'fragments'>;

/** Frozen full-index oracle from 078703b5; intentionally independent of production. */
function referenceMapping(results: readonly VectorSearchResult[], index: MappingIndex, limit = results.length): VectorSearchResult[] {
  const parentByFragment = new Map<string, string>();
  const evidenceByFragment = new Map<string, SearchFragment>();
  for (let i = 0; i < index.docIds.length; i++) {
    const fragment = index.fragments?.[i];
    parentByFragment.set(index.docIds[i], index.chunkDocIds?.[i] ?? fragment?.parentId ?? index.docIds[i]);
    if (fragment) evidenceByFragment.set(index.docIds[i], fragment);
  }
  const best = new Map<string, VectorSearchResult>();
  for (const result of results) {
    const parentId = parentByFragment.get(result.docId) ?? result.fragment?.parentId ?? result.docId;
    const fragment = result.fragment ?? evidenceByFragment.get(result.docId);
    const candidate = { ...result, docId: parentId, ...(fragment ? { fragment } : {}) };
    const current = best.get(parentId);
    if (!current || candidate.score > current.score) best.set(parentId, candidate);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId)).slice(0, Math.max(0, limit));
}

function fragment(id: string, parentId: string): SearchFragment {
  return { fragmentId: id, parentId, text: id, range: { startLine: 1, endLine: 2 }, breadcrumb: [], kind: 'text', contentHash: id, policyChecksum: 'test' };
}

function random(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
}

describe('vector parent mapping compatibility', () => {
  it('matches full-index mapping for randomized duplicate IDs, sparse evidence, unknown hits and limits', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const next = random(seed);
      const index: MappingIndex = { docIds: [], ...(seed % 3 ? { chunkDocIds: [] } : {}), ...(seed % 4 ? { fragments: [] } : {}) };
      for (let i = 0; i < 100 + seed; i++) {
        const id = `fragment-${Math.floor(next() * 40)}`;
        index.docIds.push(id);
        if (index.chunkDocIds) index.chunkDocIds[i] = `parent-${Math.floor(next() * 15)}`;
        if (index.fragments && next() > 0.3) index.fragments[i] = fragment(`evidence-${i}`, `fallback-${i % 9}`);
      }
      const results: VectorSearchResult[] = Array.from({ length: seed * 2 }, (_, i) => ({
        docId: `fragment-${Math.floor(next() * 50)}`,
        score: Math.floor(next() * 5) / 4,
        ...(i % 3 === 0 ? { fragment: fragment(`override-${i}`, `override-parent-${i}`) } : {}),
      }));
      for (const limit of [0, 1, 7, 500, -1, 1.9, NaN, Infinity]) {
        expect(mapVectorResultsToParents(results, index, limit)).toEqual(referenceMapping(results, index, limit));
      }
    }
  });

  it('keeps last parent and last truthy evidence independently for duplicate IDs', () => {
    const evidence = fragment('evidence', 'fallback');
    const index: MappingIndex = { docIds: ['duplicate', 'duplicate'], chunkDocIds: ['first', 'last'], fragments: [evidence] };
    const result = mapVectorResultsToParents([{ docId: 'duplicate', score: 0.5 }], index);
    expect(result).toEqual([{ docId: 'last', score: 0.5, fragment: evidence }]);
    expect(result[0].fragment).toBe(evidence);
  });

  it('preserves own evidence and first equal-score parent hit, with known-ID precedence', () => {
    const indexed = fragment('indexed', 'index-parent');
    const own = fragment('own', 'wrong-parent');
    const index: MappingIndex = { docIds: ['one', 'two'], chunkDocIds: ['parent', 'parent'], fragments: [indexed, indexed] };
    const results = [{ docId: 'one', score: 1, fragment: own }, { docId: 'two', score: 1 }];
    expect(mapVectorResultsToParents(results, index)).toEqual([{ docId: 'parent', score: 1, fragment: own }]);
    // Even without metadata, a known raw ID overrides an incoming fragment's parent.
    expect(mapVectorResultsToParents([results[0]], { docIds: ['one'] })[0].docId).toBe('one');
  });

  it('observes metadata mutations, replacement arrays, deletion and additions between calls', () => {
    const index: MappingIndex = { docIds: ['one'], chunkDocIds: ['parent-1'], fragments: [fragment('one', 'parent-1')] };
    const hits = [{ docId: 'one', score: 1 }, { docId: 'two', score: 0.5 }];
    const check = () => expect(mapVectorResultsToParents(hits, index)).toEqual(referenceMapping(hits, index));
    check();
    index.chunkDocIds![0] = 'changed';
    index.fragments![0].text = 'changed evidence';
    check();
    index.docIds.push('two');
    index.chunkDocIds!.push('changed');
    index.fragments!.push(fragment('two', 'changed'));
    check();
    index.docIds.splice(0, 1);
    index.chunkDocIds!.splice(0, 1);
    index.fragments!.splice(0, 1);
    check();
    index.docIds = ['one'];
    index.chunkDocIds = undefined;
    index.fragments = [fragment('one', 'replacement')];
    check();
    index.fragments[0].parentId = 'mutated-parent';
    check();
    expect(mapVectorResultsToParents(hits, { docIds: ['one'], chunkDocIds: ['new-generation'] })).toEqual(
      referenceMapping(hits, { docIds: ['one'], chunkDocIds: ['new-generation'] }));
  });

  it('reads parent/evidence metadata only for requested IDs, and skips empty-hit indexes', () => {
    const docIds = Array.from({ length: 10_000 }, (_, i) => `fragment-${i}`);
    let parentReads = 0, evidenceReads = 0;
    const index: MappingIndex = {
      docIds,
      chunkDocIds: new Proxy(docIds.map(id => `parent-${id}`), {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) parentReads++;
          return Reflect.get(target, key, receiver);
        },
      }),
      fragments: new Proxy(new Array<SearchFragment>(docIds.length), {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) evidenceReads++;
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    expect(mapVectorResultsToParents([{ docId: docIds[100], score: 1 }, { docId: docIds[9999], score: 0.5 }], index))
      .toEqual([{ docId: `parent-${docIds[100]}`, score: 1 }, { docId: `parent-${docIds[9999]}`, score: 0.5 }]);
    expect(parentReads).toBe(2);
    expect(evidenceReads).toBe(2);
    expect(mapVectorResultsToParents([], { get docIds(): string[] { throw new Error('must not scan'); } })).toEqual([]);
  });

  it('retains locale sorting, negative scores and immutable inputs', () => {
    const index: MappingIndex = { docIds: ['z', 'é', 'e\u0301'], chunkDocIds: ['z', 'é', 'e\u0301'] };
    const results = [{ docId: 'z', score: -1 }, { docId: 'é', score: 0 }, { docId: 'e\u0301', score: 0 }];
    const beforeIndex = structuredClone(index), beforeResults = structuredClone(results);
    expect(mapVectorResultsToParents(results, index)).toEqual(referenceMapping(results, index));
    expect(index).toEqual(beforeIndex);
    expect(results).toEqual(beforeResults);
    expect(mapVectorResultsToParents([], index)).toEqual([]);
  });
});
