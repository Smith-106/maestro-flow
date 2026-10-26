import { describe, expect, it } from 'vitest';
import { mapVectorResultsToParents, vectorSearch, type EmbeddingIndex } from './embedding.js';
import { updateEmbeddingRanges } from './incremental-index.js';
import { STRUCTURED_FRAGMENT_POLICY_CHECKSUM, type SearchFragment } from './structured-fragments.js';
import type { WikiEntry } from './wiki-types.js';

function entry(id: string): WikiEntry {
  return { id, type: 'knowhow', title: id, summary: '', tags: [], status: 'active', created: '', updated: '', related: [],
    source: { kind: 'file', path: `knowhow/${id}.md` }, body: '', ext: {}, scope: 'project', category: null,
    specCategory: null, createdBy: null, sourceRef: null, parent: null };
}

function makeIndex(): EmbeddingIndex {
  const docIds = ['a#0', 'a#1', 'b#0', 'c#0'];
  const parents = ['a', 'a', 'b', 'c'];
  return { modelId: 'test', dimension: 2, builtAt: 10, docIds, chunkDocIds: parents,
    vectors: docIds.map((_, i) => new Float32Array([1, i + 1])), contentHashes: docIds.map(id => `hash-${id}`),
    policyChecksum: STRUCTURED_FRAGMENT_POLICY_CHECKSUM,
    fragments: docIds.map((id, i): SearchFragment => ({ fragmentId: id, parentId: parents[i], text: `evidence ${id}`,
      range: { startLine: i + 1, endLine: i + 2 }, breadcrumb: [id], kind: 'markdown', contentHash: `hash-${id}`,
      policyChecksum: STRUCTURED_FRAGMENT_POLICY_CHECKSUM })),
  };
}

describe('incremental embedding metadata alignment', () => {
  it('reorders evidence with its vector slots and keeps prior-generation metadata intact', () => {
    const previous = makeIndex();
    const original = structuredClone(previous);
    const result = updateEmbeddingRanges(previous, ['c', 'a', 'b'].map(entry));
    const index = result.index!;
    const order = [3, 0, 1, 2];
    expect(index.docIds).toEqual(order.map(i => previous.docIds[i]));
    expect(index.fragments).toEqual(order.map(i => previous.fragments![i]));
    expect(index.contentHashes).toEqual(order.map(i => previous.contentHashes![i]));
    expect(index.chunkDocIds).toEqual(['c', 'a', 'a', 'b']);
    order.forEach((slot, i) => {
      expect(index.vectors[i]).toBe(previous.vectors[slot]);
      expect(index.fragments![i]).toBe(previous.fragments![slot]);
    });
    expect(index.fragments).not.toBe(previous.fragments);
    expect(previous).toEqual(original);
    expect(result.ranges.get('a')).toEqual({ docId: 'a', start: 1, end: 3 });
    const hits = vectorSearch(new Float32Array([1, 1]), index, 4);
    for (const hit of hits) expect(hit.fragment?.fragmentId).toBe(hit.docId);
    for (const mapped of mapVectorResultsToParents(hits, index)) expect(mapped.fragment?.parentId).toBe(mapped.docId);
  });

  it('removes changed/deleted vectors and their evidence without leaking old-generation fragments', () => {
    const previous = makeIndex();
    const result = updateEmbeddingRanges(previous, ['a', 'b', 'new'].map(entry), new Set(['b']));
    expect(result.index!.docIds).toEqual(['a#0', 'a#1']);
    expect(result.index!.fragments).toEqual(previous.fragments!.slice(0, 2));
    expect(result.index!.fragments).toHaveLength(2);
    expect(result.invalidatedDocIds).toEqual(['b', 'new']);
    expect(result.retainedDocIds).toEqual(['a']);
    expect(previous.fragments).toHaveLength(4);
    expect(updateEmbeddingRanges(previous, [], new Set()).index).toBeNull();
  });

  it('preserves an unchanged structured snapshot without reusing its mutable array container', () => {
    const previous = makeIndex();
    const index = updateEmbeddingRanges(previous, ['a', 'b', 'c'].map(entry)).index!;
    expect(index.fragments).toEqual(previous.fragments);
    expect(index.fragments).not.toBe(previous.fragments);
    expect(index.policyChecksum).toBe(previous.policyChecksum);
    expect(index.builtAt).toBe(previous.builtAt);
    expect(index.fragments!.every((fragment, i) => fragment.fragmentId === index.docIds[i])).toBe(true);
  });

  it('does not add structured metadata to legacy indexes and retains sparse slot positions', () => {
    const legacy = makeIndex();
    delete legacy.fragments;
    delete legacy.policyChecksum;
    const updated = updateEmbeddingRanges(legacy, ['b', 'a'].map(entry)).index!;
    expect(updated.fragments).toBeUndefined();
    expect(updated.policyChecksum).toBeUndefined();
    const sparse = makeIndex();
    delete sparse.fragments![1];
    const index = updateEmbeddingRanges(sparse, ['a', 'c'].map(entry)).index!;
    expect(index.fragments).toHaveLength(3);
    expect(index.fragments![0]).toBe(sparse.fragments![0]);
    expect(index.fragments![1]).toBeUndefined();
    expect(index.fragments![2]).toBe(sparse.fragments![3]);
  });
});
