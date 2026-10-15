import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiEntry } from '#maestro-dashboard/wiki/wiki-types.js';

const mocks = vi.hoisted(() => ({ daemon: vi.fn(), local: vi.fn(), code: vi.fn() }));
vi.mock('../search/daemon-client.js', () => ({
  tryDaemonSearch: mocks.daemon, readDaemonInfo: () => ({ pid: 123 }),
  isDaemonInfoV2: () => false, spawnDaemon: vi.fn(async () => undefined),
}));
vi.mock('#maestro-dashboard/wiki/wiki-indexer.js', () => ({
  WikiIndexer: class { searchWithMeta = mocks.local; close = vi.fn(); },
}));
vi.mock('../graph/kg/engine.js', () => ({
  MaestroGraph: { open: async () => ({ searchCode: mocks.code, close() {} }) },
}));
import { runCodeSearch, runUnifiedSearch, selectDiverseWikiCandidates } from './search.js';
import { createSearchDiagnostics, finishSearchDiagnostics } from '../search/diagnostics.js';
import { computeSearchCandidateBudget } from '../search/candidate-budget.js';

function entry(id: string, parent: string | null = null): WikiEntry {
  return { id, title: id, type: 'knowhow', category: 'coding', summary: id,
    body: id, tags: [], status: 'active', source: { kind: 'virtual', path: id },
    parent, ext: {}, raw: {}, related: [], created: null, updated: null,
    scope: null, specCategory: null, createdBy: null } as WikiEntry;
}
const cwd = process.cwd();
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'search-selection-'));
  mkdirSync(join(root, '.workflow', 'kg'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'kg', 'maestro.db'), '');
  process.chdir(root);
  vi.clearAllMocks();
  mocks.local.mockResolvedValue({ results: [{ entry: entry('local'), score: 1 }], embeddingUsed: false, embeddingDocs: 0 });
});
afterEach(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('selection and telemetry invariants', () => {
  it('preserves independent numeric IDs without parent provenance', () => {
    const candidates = ['http-400', 'http-401', 'http-404'].map((id, i) => ({ entry: entry(id), score: 10 - i }));
    for (const diversity of ['off', 'balanced'] as const) {
      expect(selectDiverseWikiCandidates(candidates, { limit: 3, applyCaps: false, diversity }).map(r => r.entry.id))
        .toEqual(['http-400', 'http-401', 'http-404']);
    }
  });
  it('retains explicit parent family caps without conflating distinct numbered parents', () => {
    const candidates = [entry('a', 'guide-400'), entry('b', 'guide-400'), entry('c', 'guide-400'), entry('d', 'guide-401')]
      .map((entry, i) => ({ entry, score: 10 - i }));
    expect(selectDiverseWikiCandidates(candidates, { limit: 4, applyCaps: false, diversity: 'off' }).map(r => r.entry.id)).toEqual(['a', 'b', 'd']);
  });
  it.each([undefined, false, true])('diagnostics does not change faceted daemon acceptance (filtersApplied=%s)', async filtersApplied => {
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied, results: [{ entry: entry('daemon'), score: 2 }] });
    const without = await runUnifiedSearch('query', { category: 'coding', limit: 2, skipEmbedding: true, deferImpressions: true });
    const diagnostics = createSearchDiagnostics();
    const withDiagnostics = await runUnifiedSearch('query', { category: 'coding', limit: 2, skipEmbedding: true, deferImpressions: true, diagnostics });
    expect(withDiagnostics).toEqual(without);
    expect(withDiagnostics[0].id).toBe(filtersApplied === true ? 'daemon' : 'local');
  });
  it.each([undefined, false, true])('diagnostics does not change the semantic gate (filtersApplied=%s)', async filtersApplied => {
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied, results: [{ entry: entry('daemon'), score: 2 }] });
    for (const diagnostics of [undefined, createSearchDiagnostics()]) {
      mocks.daemon.mockClear();
      await runUnifiedSearch('query', { category: 'coding', limit: 2, skipEmbedding: false, deferImpressions: true, diagnostics });
      expect(mocks.daemon).toHaveBeenCalledTimes(filtersApplied === true ? 2 : 1);
    }
  });
  it('requires the applicability filter marker even without a user facet', async () => {
    mocks.daemon.mockResolvedValue({ ok: true, results: [{ entry: entry('daemon'), score: 2 }] });
    for (const diagnostics of [undefined, createSearchDiagnostics()]) {
      expect((await runUnifiedSearch('query', { limit: 2, skipEmbedding: true, deferImpressions: true, diagnostics }))[0].id).toBe('local');
    }
  });
  it('does not warn about disabled embeddings for an ordinary BM25 fallback', async () => {
    mocks.daemon.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runUnifiedSearch('query', { limit: 2, skipEmbedding: true, deferImpressions: true });
    expect(error).not.toHaveBeenCalled();
    await runUnifiedSearch('query', { limit: 2, skipEmbedding: false, deferImpressions: true });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('embedding disabled'));
  });
  it('records eligible code candidates from the final adaptive pass', async () => {
    const node = (id: string) => ({ id, kind: 'function', name: id, filePath: 'src/x.ts', startLine: 1 });
    const budget = computeSearchCandidateBudget(3, { surface: 'code', mode: 'adaptive' });
    mocks.code.mockReturnValueOnce(Array.from({ length: budget.candidateLimit }, () => node('same')))
      .mockReturnValueOnce([node('first'), node('second'), node('third')]);
    const diagnostics = createSearchDiagnostics();
    const outcome = await runCodeSearch('query', 3, true, false, root, 'default', diagnostics, budget);
    expect(mocks.code).toHaveBeenCalledTimes(2);
    expect(outcome.results).toHaveLength(3);
    expect(finishSearchDiagnostics(diagnostics).eligibleCandidateCount).toBe(3);
  });
});
