/**
 * Isolated exact-search A/B; no model, daemon, credentials or filesystem index.
 * Run: node dashboard/node_modules/tsx/dist/cli.mjs scripts/benchmark-flat-vector-search.ts
 * Optional: --samples 15 --warmup 3 --built (requires npm run build)
 * The frozen reference is the full-sort implementation from 9b184f453d3c.
 * This measures vector selection only, NOT CLI, embedding or native ANN latency.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { EmbeddingIndex, VectorSearchResult } from '../dashboard/src/server/wiki/embedding.js';

const { values } = parseArgs({ options: {
  samples: { type: 'string', default: '15' },
  warmup: { type: 'string', default: '3' },
  built: { type: 'boolean', default: false },
} });
const { vectorSearch } = values.built
  ? await import('../dashboard/dist-server/dashboard/src/server/wiki/embedding.js')
  : await import('../dashboard/src/server/wiki/embedding.js');
const samples = Number(values.samples);
const warmup = Number(values.warmup);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 100, '--samples must be an integer in [3,100]');
assert(Number.isInteger(warmup) && warmup >= 0 && warmup <= 100, '--warmup must be an integer in [0,100]');

function referenceSearch(query: Float32Array, index: EmbeddingIndex, limit: number, allowed?: ReadonlySet<string>): VectorSearchResult[] {
  const scored: VectorSearchResult[] = [];
  for (let slot = 0; slot < index.docIds.length; slot++) {
    if (allowed && !allowed.has(index.chunkDocIds?.[slot] ?? index.docIds[slot])) continue;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < query.length; i++) {
      dot += query[i] * index.vectors[slot][i];
      normA += query[i] * query[i];
      normB += index.vectors[slot][i] * index.vectors[slot][i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const score = denom === 0 ? 0 : dot / denom;
    if (score > 0) scored.push({ docId: index.docIds[slot], score });
  }
  return scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId)).slice(0, limit);
}

function makeCorpus(count: number, dimension: number): { index: EmbeddingIndex; query: Float32Array } {
  let seed = 0x5eed;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const query = Float32Array.from({ length: dimension }, () => next() * 2 - 1);
  const index: EmbeddingIndex = {
    modelId: 'synthetic-seed-0x5eed', dimension, builtAt: 0,
    docIds: Array.from({ length: count }, (_, i) => `doc-${i.toString().padStart(7, '0')}`),
    vectors: Array.from({ length: count }, () => Float32Array.from({ length: dimension }, () => next() * 2 - 1)),
  };
  return { index, query };
}

function percentile(input: number[], fraction: number): number {
  return input.slice().sort((a, b) => a - b)[Math.ceil(input.length * fraction) - 1];
}

const rows: object[] = [];
for (const [count, dimension] of [[1000, 384], [10000, 384], [100000, 384], [10000, 1536]]) {
  const { index, query } = makeCorpus(count, dimension);
  for (const [filter, stride, limit] of [['all', 1, 20], ['all-filtered', 1, 20], ['half', 2, 500], ['sparse', 100, 20]] as const) {
    const allowed = filter === 'all' ? undefined : new Set(index.docIds.filter((_, i) => i % stride === 0));
    const expected = referenceSearch(query, index, limit, allowed);
    assert.deepStrictEqual(vectorSearch(query, index, limit, allowed), expected);
    const baseline: number[] = [], optimized: number[] = [];
    const run = (candidate: boolean, record: boolean) => {
      const startedAt = performance.now();
      const result = candidate ? vectorSearch(query, index, limit, allowed) : referenceSearch(query, index, limit, allowed);
      const duration = performance.now() - startedAt;
      // Keep verification out of the timed window; assert every measured result.
      assert.deepStrictEqual(result, expected);
      if (record) (candidate ? optimized : baseline).push(duration);
    };
    for (let i = 0; i < warmup + samples; i++) {
      // Alternate ordering to reduce warm-up, CPU load and GC ordering bias.
      run(i % 2 === 0, i >= warmup);
      run(i % 2 !== 0, i >= warmup);
    }
    const before = percentile(baseline, 0.5), after = percentile(optimized, 0.5);
    rows.push({ count, dimension, filter, limit, exact: true,
      baselineMedianMs: +before.toFixed(3), optimizedMedianMs: +after.toFixed(3),
      medianImprovementPercent: +(100 * (before - after) / before).toFixed(1),
      baselineP95Ms: +percentile(baseline, 0.95).toFixed(3), optimizedP95Ms: +percentile(optimized, 0.95).toFixed(3),
      baselineSamplesMs: baseline, optimizedSamplesMs: optimized,
    });
  }
}
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* identity remains explicit */ }
console.log(JSON.stringify({ benchmark: 'flat-vector-search-ab/1.0', referenceCommit: '9b184f453d3c29cf5c49c104b20a733b8c91ee17',
  commit, node: process.version, platform: platform(), cpu: cpus()[0]?.model,
  samples, warmup, implementation: values.built ? 'built' : 'source', seed: '0x5eed',
  scope: 'synthetic in-process flat cosine search only; source/build may contain uncommitted changes', rows }, null, 2));
