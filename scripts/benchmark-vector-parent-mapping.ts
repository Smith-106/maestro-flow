/**
 * Isolated parent-mapping A/B; metadata only, no vectors, model, daemon or index files.
 * Run: node dashboard/node_modules/tsx/dist/cli.mjs scripts/benchmark-vector-parent-mapping.ts
 * Optional: --samples 15 --warmup 3 --built (requires an existing dashboard build)
 * The frozen reference is the exact mapper from 078703b55919b8add52dd9a51f39f32e64dbe409.
 * Run this same harness before/after production changes; this is NOT end-to-end search latency.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { EmbeddingIndex, VectorSearchResult } from '../dashboard/src/server/wiki/embedding.js';
import type { SearchFragment } from '../dashboard/src/server/wiki/structured-fragments.js';

const { values } = parseArgs({ options: {
  samples: { type: 'string', default: '15' },
  warmup: { type: 'string', default: '3' },
  built: { type: 'boolean', default: false },
} });
const samples = Number(values.samples);
const warmup = Number(values.warmup);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 100, '--samples must be an integer in [3,100]');
assert(Number.isInteger(warmup) && warmup >= 0 && warmup <= 100, '--warmup must be an integer in [0,100]');
const { mapVectorResultsToParents } = values.built
  ? await import('../dashboard/dist-server/dashboard/src/server/wiki/embedding.js')
  : await import('../dashboard/src/server/wiki/embedding.js');

type MappingIndex = Pick<EmbeddingIndex, 'docIds' | 'chunkDocIds' | 'fragments'>;
type Variant = 'legacy-chunk-parents' | 'structured-evidence';
const seed = 0x5eed;

// Frozen verbatim except for the function name/export; do not optimize this reference.
function referenceMapVectorResultsToParents(
  results: readonly VectorSearchResult[],
  index: Pick<EmbeddingIndex, 'docIds' | 'chunkDocIds' | 'fragments'>,
  limit = results.length,
): VectorSearchResult[] {
  const parentByFragment = new Map<string, string>();
  const evidenceByFragment = new Map<string, SearchFragment>();
  for (let i = 0; i < index.docIds.length; i++) {
    const fragment = index.fragments?.[i];
    const parentId = index.chunkDocIds?.[i] ?? fragment?.parentId ?? index.docIds[i];
    parentByFragment.set(index.docIds[i], parentId);
    if (fragment) evidenceByFragment.set(index.docIds[i], fragment);
  }
  const best = new Map<string, VectorSearchResult>();
  for (const result of results) {
    const parentId = parentByFragment.get(result.docId) ?? result.fragment?.parentId ?? result.docId;
    const fragment = result.fragment ?? evidenceByFragment.get(result.docId);
    const candidate = {
      ...result,
      docId: parentId,
      ...(fragment ? { fragment } : {}),
    };
    const current = best.get(parentId);
    if (!current || candidate.score > current.score) best.set(parentId, candidate);
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score || left.docId.localeCompare(right.docId))
    .slice(0, Math.max(0, limit));
}

function evidence(fragmentId: string, parentId: string, ordinal: number): SearchFragment {
  return {
    fragmentId, parentId, text: `synthetic evidence ${ordinal}`,
    range: { startLine: ordinal + 1, endLine: ordinal + 2 },
    breadcrumb: ['synthetic', `section-${ordinal}`], kind: 'markdown',
    contentHash: `synthetic-hash-${ordinal}`, policyChecksum: 'synthetic-policy',
  };
}

function makeIndex(count: number, variant: Variant): MappingIndex {
  const docIds = Array.from({ length: count }, (_, slot) => {
    // Two duplicate-ID pairs per 32 slots; their final slots have different parents.
    const idSlot = slot % 32 === 23 || slot % 32 === 31 ? slot - 7 : slot;
    return `fragment-${idSlot.toString().padStart(7, '0')}`;
  });
  const parentId = (slot: number) => `parent-${Math.floor(slot / 4).toString().padStart(7, '0')}`;
  if (variant === 'legacy-chunk-parents') {
    return { docIds, chunkDocIds: docIds.map((_, slot) => parentId(slot)) };
  }
  const fragments = new Array<SearchFragment>(count);
  for (let slot = 0; slot < count; slot++) {
    // A missing later duplicate must not erase the earlier truthy evidence.
    if (slot % 32 !== 31) fragments[slot] = evidence(docIds[slot], parentId(slot), slot);
  }
  return { docIds, fragments };
}

function makeHits(index: MappingIndex, count: number): VectorSearchResult[] {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  // Always exercise equal/lower/greater parent duplicates and both duplicate-ID pairs.
  const fixedSlots = [0, 1, 2, 3, 16, 23, 24, 31];
  const fixedScores = [0.5, 0.5, 0.75, 0.25, 0.5, 0.75, 0.5, 0.25];
  return Array.from({ length: count }, (_, hit) => {
    const slot = fixedSlots[hit] ?? Math.floor(next() * index.docIds.length);
    const docId = hit >= 8 && hit % 17 === 0 ? `unindexed-${hit}` : index.docIds[slot];
    return {
      docId, score: fixedScores[hit] ?? Math.floor(next() * 8) / 8,
      ...(hit % 5 === 0 || (hit >= 8 && hit % 17 === 0)
        ? { fragment: evidence(docId, `override-parent-${hit}`, index.docIds.length + hit) } : {}),
    };
  });
}

// Untimed edge checks supplement the realistic fixtures: precedence, duplicate IDs,
// truthy evidence retention, strict-greater ties, locale ordering and slice coercion.
const firstEvidence = evidence('duplicate', 'evidence-parent', 0);
const lastEvidence = evidence('duplicate', 'ignored-evidence-parent', 1);
const override = evidence('duplicate', 'ignored-override-parent', 2);
const edgeIndex: MappingIndex = {
  docIds: ['duplicate', 'duplicate', 'duplicate', 'sibling'],
  chunkDocIds: ['old-parent', 'last-parent', 'last-parent', 'last-parent'],
  fragments: [firstEvidence, lastEvidence],
};
const edgeHits: VectorSearchResult[] = [
  { docId: 'duplicate', score: 0.5 },
  { docId: 'sibling', score: 0.5, fragment: override },
  { docId: 'duplicate', score: 0.75, fragment: override },
  { docId: 'sibling', score: 0.75 },
  { docId: 'z-parent', score: 0.75 },
  { docId: 'a-parent', score: 0.75 },
  { docId: 'missing', score: 0.25, fragment: evidence('missing', 'fallback-parent', 3) },
];
assert.deepStrictEqual(referenceMapVectorResultsToParents(edgeHits.slice(0, 2), edgeIndex), [
  { docId: 'last-parent', score: 0.5, fragment: lastEvidence },
]);
assert.deepStrictEqual(referenceMapVectorResultsToParents(edgeHits.slice(0, 4), edgeIndex), [
  { docId: 'last-parent', score: 0.75, fragment: override },
]);
for (const limit of [undefined, -2, 0, 1, 2.75, Infinity, NaN]) {
  assert.deepStrictEqual(mapVectorResultsToParents(edgeHits, edgeIndex, limit),
    referenceMapVectorResultsToParents(edgeHits, edgeIndex, limit));
}

function percentile(input: number[], fraction: number): number {
  return input.slice().sort((a, b) => a - b)[Math.ceil(input.length * fraction) - 1];
}

const rows: object[] = [];
for (const count of [1000, 10000, 100000]) {
  for (const variant of ['legacy-chunk-parents', 'structured-evidence'] as const) {
    const index = makeIndex(count, variant);
    // Exactly one empty-hit scenario per size, alongside both 20/500-hit variants.
    const hitCounts = variant === 'legacy-chunk-parents' ? [20, 500, 0] : [20, 500];
    for (const incomingHits of hitCounts) {
      const results = makeHits(index, incomingHits);
      const limit = Math.min(20, incomingHits);
      const expected = referenceMapVectorResultsToParents(results, index, limit);
      assert.deepStrictEqual(mapVectorResultsToParents(results, index, limit), expected);
      const baseline: number[] = [], current: number[] = [];
      const run = (candidate: boolean, record: boolean) => {
        const startedAt = performance.now();
        const result = candidate
          ? mapVectorResultsToParents(results, index, limit)
          : referenceMapVectorResultsToParents(results, index, limit);
        const duration = performance.now() - startedAt;
        // Every result is checked, but assertion cost is outside the timed window.
        assert.deepStrictEqual(result, expected);
        if (record) (candidate ? current : baseline).push(duration);
      };
      for (let i = 0; i < warmup + samples; i++) {
        // Alternate first implementation to reduce CPU/GC/order bias.
        run(i % 2 === 0, i >= warmup);
        run(i % 2 !== 0, i >= warmup);
      }
      const before = percentile(baseline, 0.5), after = percentile(current, 0.5);
      rows.push({ count, incomingHits, variant, limit, resultCount: expected.length, exact: true,
        baselineMedianMs: before, currentMedianMs: after,
        medianImprovementPercent: 100 * (before - after) / before,
        baselineP95Ms: percentile(baseline, 0.95), currentP95Ms: percentile(current, 0.95),
        baselineSamplesMs: baseline, currentSamplesMs: current,
      });
    }
  }
}
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* identity remains explicit */ }
console.log(JSON.stringify({ benchmark: 'vector-parent-mapping-ab/1.0',
  referenceCommit: '078703b55919b8add52dd9a51f39f32e64dbe409', commit,
  node: process.version, platform: platform(), cpu: cpus()[0]?.model,
  samples, warmup, implementation: values.built ? 'built' : 'source', seed: `0x${seed.toString(16)}`,
  scope: 'synthetic in-process metadata-only parent mapping; no end-to-end latency claim; source/build may contain uncommitted changes',
  rows,
}, null, 2));
