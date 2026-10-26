import { describe, expect, it, vi } from 'vitest';
import { SearchProviderError, type SearchCandidate, type SearchProvider, type ProviderSearchResult } from '../../../shared/search-provider.js';
import { runSearchGateway, readSearchSource } from './gateway.js';
import { createLocalSearchProvider } from './local.js';

const authority = { repoId: 'repo-a', workspaceFence: 'repo:repo-a' };
function hit(providerId: string, recordId: string, score = 1): SearchCandidate {
  return { ref: { providerId, namespace: `${providerId}-scope`, recordId }, kind: 'memory', title: recordId, snippet: '',
    trust: providerId === 'local' ? 'local' : 'external', rawScore: { value: score, metric: 'test-score' } };
}
function provider(id: string, records = [hit(id, 'same')]): SearchProvider {
  return { id, namespace: `${id}-scope`, external: id !== 'local',
    capabilities: { modes: ['auto'], filters: [], maxCandidates: 100, read: false },
    search: vi.fn(async () => ({ hits: records, complete: true })) };
}

describe('shared search gateway', () => {
  it('rank-interleaves distinct namespaces without summing incompatible raw scores', async () => {
    const local = provider('local', [hit('local', 'same', 0.1), hit('local', 'two', 0.05)]);
    const remote = provider('remote', [hit('remote', 'same', 99999)]);
    const result = await runSearchGateway({ query: 'test', authority, providers: [local, remote] });
    expect(result.results.map(h => [h.ref.providerId, h.ref.recordId])).toEqual([['local', 'same'], ['remote', 'same'], ['local', 'two']]);
    expect(result.results[1].rawScore?.value).toBe(99999);
    expect(result.results[0].fusionScore).toBe(result.results[1].fusionScore);
    expect(result.schemaVersion).toBe('maestro-search/1.0');
    expect(result.mutationAuthorized).toBe(false);
    expect(result.complete).toBe(true);
  });

  it('deduplicates per-source identities before limiting and retains the first ranked version', async () => {
    const first = hit('local', 'same');
    first.ref.version = '1';
    const other = hit('local', 'same', 9);
    other.ref.version = '2';
    const result = await runSearchGateway({ query: 'q', authority, providers: [provider('local', [first, other, hit('local', 'two')])], limit: 2 });
    expect(result.results.map(h => h.ref.recordId)).toEqual(['same', 'two']);
    expect(result.results[0].ref.version).toBe('1');
  });

  it('preserves local results on provider failure and never serializes exception contents', async () => {
    const remote = provider('remote');
    remote.search = vi.fn(async () => { throw new Error('secret query token https://private.example'); });
    const result = await runSearchGateway({ query: 'q', authority, providers: [provider('local'), remote] });
    expect(result.results).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.providers[1]).toMatchObject({ status: 'error', code: 'provider-error' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private.example');
  });

  it('rejects unsupported modes and facets before invoking a provider', async () => {
    const remote = provider('remote');
    const mode = await runSearchGateway({ query: 'q', authority, providers: [remote], mode: 'lexical' });
    expect(mode.providers[0].code).toBe('unsupported-mode');
    const facet = await runSearchGateway({ query: 'q', authority, providers: [remote], filters: { type: 'spec' } });
    expect(facet.providers[0].code).toBe('unsupported-filter');
    expect(remote.search).not.toHaveBeenCalled();
  });

  it('passes one bounded candidate budget and propagates incomplete coverage', async () => {
    const remote = provider('remote');
    remote.search = vi.fn(async () => ({ hits: [], complete: false, warnings: ['upstream-filtered-candidates'] }));
    const result = await runSearchGateway({ query: 'q', authority, providers: [remote], limit: 500 });
    expect(remote.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, candidateLimit: 100 }));
    expect(result.providers[0]).toMatchObject({ status: 'degraded', warnings: ['upstream-filtered-candidates'] });
  });

  it('forbids all external providers in hermetic probe before executing any provider', async () => {
    const local = provider('local'), remote = provider('remote');
    await expect(runSearchGateway({ query: 'q', authority, providers: [local, remote], executionMode: 'read-only-probe' }))
      .rejects.toMatchObject({ code: 'probe-forbidden' });
    expect(local.search).not.toHaveBeenCalled();
    expect(remote.search).not.toHaveBeenCalled();
  });

  it('bounds non-cooperating plugins by deadline and propagates explicit cancellation', async () => {
    const remote = provider('remote');
    remote.search = vi.fn(() => new Promise(() => {}));
    const timed = await runSearchGateway({ query: 'q', authority, providers: [remote], deadlineAt: Date.now() + 25 });
    expect(timed.providers[0].code).toBe('timeout');
    const abort = new AbortController();
    const pending = runSearchGateway({ query: 'q', authority, providers: [remote], signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    const alreadyAborted = vi.fn();
    remote.search = alreadyAborted;
    await expect(runSearchGateway({ query: 'q', authority, providers: [remote], signal: abort.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(alreadyAborted).not.toHaveBeenCalled();
  });

  it('rejects forged identity/trust, nonfinite scores and oversized provider batches', async () => {
    const invalid = [
      { ...hit('remote', 'a'), ref: { ...hit('remote', 'a').ref, namespace: 'other-scope' } },
      { ...hit('remote', 'a'), trust: 'local' },
      { ...hit('remote', 'a'), rawScore: { value: Infinity, metric: 'test' } },
      { ...hit('remote', 'a'), snippet: 'x'.repeat(4097) },
    ];
    for (const candidate of invalid) {
      const remote = provider('remote');
      // Exercise malformed third-party implementations beyond the typed port.
      remote.search = async () => ({ hits: [candidate], complete: true }) as ProviderSearchResult;
      const result = await runSearchGateway({ query: 'q', authority, providers: [remote] });
      expect(result.results).toEqual([]);
      expect(result.providers[0].code).toBe('remote-response-invalid');
    }
    const remote = provider('remote', Array.from({ length: 41 }, (_, i) => hit('remote', String(i))));
    expect((await runSearchGateway({ query: 'q', authority, providers: [remote] })).providers[0].code).toBe('remote-response-invalid');
  });

  it('rejects invalid query, limits, deadlines, duplicate providers and unknown filters', async () => {
    for (const patch of [{ query: '' }, { query: 'x'.repeat(2049) }, { limit: 0 }, { limit: NaN }, { candidateLimit: 501 },
      { deadlineAt: Infinity }, { providers: [] }, { providers: [provider('local'), provider('local')] }, { filters: { other: 'x' } }]) {
      await expect(runSearchGateway({ query: 'q', authority, providers: [provider('local')], ...patch })).rejects.toMatchObject({ code: 'invalid-request' });
    }
  });

  it('wraps local engines lazily and keeps canonical references and provenance', async () => {
    const search = vi.fn(async () => [{ id: 'spec:one', title: 'One', score: 2, sourceRef: 'run-one', path: 'specs/one.md', workspaceFence: 'repo:origin' }]);
    const local = createLocalSearchProvider({ namespace: authority.workspaceFence, search });
    expect(search).not.toHaveBeenCalled();
    const result = await runSearchGateway({ query: 'q', authority, providers: [local], mode: 'lexical', filters: { type: 'spec' } });
    expect(result.results[0]).toMatchObject({ ref: { providerId: 'local', recordId: 'spec:one' }, trust: 'local', kind: 'knowledge',
      source: { sourceRef: 'run-one', path: 'specs/one.md', workspaceFence: 'repo:origin' } });
  });

  it('validates source resolver namespace, capability, deadline and version', async () => {
    const remote = provider('remote');
    const ref = hit('remote', 'one').ref;
    const context = { authority, signal: new AbortController().signal, deadlineAt: Date.now() + 1000, executionMode: 'default' as const };
    await expect(readSearchSource(remote, ref, context)).rejects.toMatchObject({ code: 'read-unsupported' });
    remote.capabilities.read = true;
    remote.resolver = { read: vi.fn(async () => ({ ref: { ...ref, version: '2' }, content: 'source', trust: 'external' })) };
    await expect(readSearchSource(remote, { ...ref, namespace: 'other' }, context)).rejects.toMatchObject({ code: 'stale-reference' });
    expect(remote.resolver.read).not.toHaveBeenCalled();
    expect((await readSearchSource(remote, ref, context)).content).toBe('source');
    await expect(readSearchSource(remote, { ...ref, version: '1' }, context)).rejects.toMatchObject({ code: 'stale-reference' });
    await expect(readSearchSource(remote, ref, { ...context, deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(readSearchSource(remote, ref, { ...context, executionMode: 'read-only-probe' })).rejects.toMatchObject({ code: 'probe-forbidden' });
  });
});
