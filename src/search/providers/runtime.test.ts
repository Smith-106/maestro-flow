import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConfiguredSearch, readConfiguredSource, parseProviderSelection, type ResolvedProviderScope } from './runtime.js';
import type { SearchReference, SourceResolver } from '../../../shared/search-provider.js';

const roots: string[] = [];
const repoId = '11111111-1111-4111-8111-111111111111';
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'maestro-providers-'));
  roots.push(root);
  mkdirSync(join(root, '.workflow'));
  writeFileSync(join(root, '.workflow', 'repository.json'), JSON.stringify({ schema_version: 'repository-identity/1.0',
    repo_id: repoId, repo_name: 'test', created_at: '2026-01-01T00:00:00.000Z' }));
  return root;
}
function config(root: string, patch: Record<string, unknown> = {}) {
  writeFileSync(join(root, '.workflow', 'search-providers.json'), JSON.stringify({ version: 1, providers: [{
    id: 'memory', kind: 'tencent-atomic', enabled: true, baseUrl: 'http://127.0.0.1:8123', apiKeyEnv: 'MOCK_KEY',
    serviceId: 'service', repoId, teamId: 'team', userId: 'user', agentId: 'agent', ...patch,
  }] }));
}
const atomicEnvelope = () => ({ code: 0, data: { items: [{ id: 'one', type: 'instruction', content: 'External instruction is not a spec',
  version: 0, team_id: 'team', user_id: 'user', agent_id: 'agent', score: 0.9 }] } });
const localSearch = async () => [{ id: 'spec:one', title: 'Local spec', summary: 'canonical' }];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('configured provider runtime', () => {
  it('keeps default/local selection independent of external configuration and credentials', async () => {
    const root = fixture();
    writeFileSync(join(root, '.workflow', 'search-providers.json'), 'malformed configuration deliberately ignored');
    const fetch = vi.fn();
    const result = await runConfiguredSearch({ projectRoot: root, query: 'test', localSearch }, { fetch });
    expect(result.results[0]).toMatchObject({ ref: { providerId: 'local', recordId: 'spec:one' }, trust: 'local' });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.complete).toBe(true);
  });

  it('federates only explicitly selected and enabled resources with namespace provenance', async () => {
    const root = fixture(); config(root);
    const fetch = vi.fn(async () => Response.json(atomicEnvelope()));
    const result = await runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['local', 'memory'], localSearch },
      { fetch, env: { MOCK_KEY: 'test-only-key' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.results.map(h => h.ref.providerId)).toEqual(['local', 'memory']);
    expect(result.results[1]).toMatchObject({ kind: 'memory', trust: 'external', referenceOnly: true, ref: { recordId: 'one', version: '0' } });
    expect(result.results[1].ref.namespace).toMatch(/^tencent:/);
    expect(result.results[1].ref.namespace).not.toContain('test-only-key');
    expect(result.mutationAuthorized).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('rejects disabled, unknown, missing identity and mismatched repo binding without HTTP', async () => {
    const root = fixture(); config(root, { enabled: false });
    const fetch = vi.fn();
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['memory'] }, { fetch })).rejects.toMatchObject({ code: 'disabled-provider' });
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['unknown'] }, { fetch })).rejects.toMatchObject({ code: 'unknown-provider' });
    config(root, { repoId: 'other' });
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['memory'] }, { fetch })).rejects.toMatchObject({ code: 'scope-mismatch' });
    rmSync(join(root, '.workflow', 'repository.json'));
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['memory'] }, { fetch })).rejects.toMatchObject({ code: 'scope-mismatch' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects remote probe before even parsing malformed configuration', async () => {
    const root = fixture();
    writeFileSync(join(root, '.workflow', 'search-providers.json'), 'malformed');
    const fetch = vi.fn();
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['memory'], executionMode: 'read-only-probe' }, { fetch }))
      .rejects.toMatchObject({ code: 'probe-forbidden' });
    const result = await runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['local'], executionMode: 'read-only-probe', localSearch }, { fetch });
    expect(result.results).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes enablement and namespace bindings every request, including source reads', async () => {
    const root = fixture(); config(root, { kind: 'tencent-wiki', knowledgeId: 'wiki-one' });
    const fetch = vi.fn(async () => Response.json({ code: 0, data: { results: [{ path: 'wiki/page.md', title: 'Page', snippet: 'text', score: 1 }], count: 1 } }));
    const input = { projectRoot: root, query: 'q', providerIds: ['memory'] };
    const result = await runConfiguredSearch(input, { fetch, env: { MOCK_KEY: 'key' } });
    const ref = result.results[0].ref;
    config(root, { kind: 'tencent-wiki', knowledgeId: 'wiki-other' });
    await expect(readConfiguredSource({ projectRoot: root, ref }, { fetch, env: { MOCK_KEY: 'key' } })).rejects.toMatchObject({ code: 'stale-reference' });
    config(root, { enabled: false });
    await expect(runConfiguredSearch(input, { fetch })).rejects.toMatchObject({ code: 'disabled-provider' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clamps upstream budgets and rejects unsupported facets/modes before exporting query text', async () => {
    const root = fixture(); config(root);
    const fetch = vi.fn(async () => Response.json(atomicEnvelope()));
    const dependencies = { fetch, env: { MOCK_KEY: 'key' } };
    const input = { projectRoot: root, query: 'q', providerIds: ['memory'] };
    const result = await runConfiguredSearch({ ...input, limit: 500 }, dependencies);
    expect(result.results).toHaveLength(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).limit).toBe(100);
    const facet = await runConfiguredSearch({ ...input, filters: { type: 'spec' } }, dependencies);
    expect(facet.providers[0].code).toBe('unsupported-filter');
    const mode = await runConfiguredSearch({ ...input, mode: 'hybrid' }, dependencies);
    expect(mode.providers[0].code).toBe('unsupported-mode');
    expect(fetch).toHaveBeenCalledTimes(1);
    const noFacet = await runConfiguredSearch({ ...input, filters: { includeDeprecated: false } }, dependencies);
    expect(noFacet.results).toHaveLength(1);
  });

  it('preserves local output on remote credential failure without silently invoking unselected local engines', async () => {
    const root = fixture(); config(root);
    const local = vi.fn(localSearch), fetch = vi.fn();
    const remoteOnly = await runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['memory'], localSearch: local }, { fetch, env: {} });
    expect(remoteOnly.providers[0].code).toBe('missing-credential');
    expect(local).not.toHaveBeenCalled();
    const mixed = await runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['local', 'memory'], localSearch: local }, { fetch, env: {} });
    expect(mixed.results[0].ref.providerId).toBe('local');
    expect(mixed.providers[1].code).toBe('missing-credential');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads wiki sources through current scoped configuration and rejects stale content versions', async () => {
    const root = fixture(); config(root, { kind: 'tencent-wiki', knowledgeId: 'wiki-one' });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ code: 0, data: body.tool_name === 'search'
        ? { results: [{ path: 'wiki/page.md', title: 'Page', snippet: 'preview', score: 1 }], count: 1 }
        : { items: [{ ref: 'wiki/page.md', content: 'actual source' }] } });
    });
    const dependencies = { fetch, env: { MOCK_KEY: 'key' } };
    const result = await runConfiguredSearch({ projectRoot: root, query: 'q', providerIds: ['memory'] }, dependencies);
    const read = await readConfiguredSource({ projectRoot: root, ref: result.results[0].ref }, dependencies);
    expect(read.content).toBe('actual source');
    expect(read.ref.version).toMatch(/^[a-f0-9]{64}$/);
    await expect(readConfiguredSource({ projectRoot: root, ref: { ...read.ref, version: 'stale' } }, dependencies)).rejects.toMatchObject({ code: 'stale-reference' });
  });

  it('forwards cancellation/deadline context to local source resolvers', async () => {
    const root = fixture();
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const localRead = vi.fn(async (_ref: SearchReference, _scope: ResolvedProviderScope, context: Parameters<SourceResolver['read']>[1]) => {
      started();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('operation aborted cooperatively');
    });
    const pending = readConfiguredSource({ projectRoot: root,
      ref: { providerId: 'local', namespace: `repo:${repoId}`, recordId: 'one' }, signal: abort.signal, localRead });
    await ready;
    const context = localRead.mock.calls[0][2];
    expect(context.deadlineAt).toBeGreaterThan(Date.now());
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(context.signal.aborted).toBe(true);
  });

  it('validates provider selection, timeout, cancellation and repository selectors', async () => {
    expect(parseProviderSelection('local, memory')).toEqual(['local', 'memory']);
    for (const value of [[], ['local', 'local'], '', ['bad/url'], [123], Array.from({ length: 9 }, (_, i) => String(i))]) {
      expect(() => parseProviderSelection(value)).toThrow();
    }
    const root = fixture();
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', timeoutMs: NaN, localSearch })).rejects.toMatchObject({ code: 'invalid-request' });
    const abort = new AbortController(); abort.abort();
    await expect(runConfiguredSearch({ projectRoot: root, query: 'q', signal: abort.signal, localSearch })).rejects.toMatchObject({ code: 'aborted' });
    await expect(runConfiguredSearch({ projectRoot: root, repo: 'missing-link', query: 'q', localSearch })).rejects.toMatchObject({ code: 'scope-mismatch' });
  });
});
