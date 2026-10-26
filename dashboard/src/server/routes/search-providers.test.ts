import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSearchProviderRoutes } from './search-providers.js';
import { WikiIndexer } from '../wiki/wiki-indexer.js';

const roots: string[] = [];
const indexes: WikiIndexer[] = [];
const repoId = '11111111-1111-4111-8111-111111111111';
function context(id = repoId) {
  const root = mkdtempSync(join(tmpdir(), 'provider-routes-')); roots.push(root);
  const workflowRoot = join(root, '.workflow');
  mkdirSync(join(workflowRoot, 'specs'), { recursive: true });
  writeFileSync(join(workflowRoot, 'repository.json'), JSON.stringify({ schema_version: 'repository-identity/1.0',
    repo_id: id, repo_name: 'provider-routes', created_at: '2026-01-01T00:00:00.000Z' }));
  writeFileSync(join(workflowRoot, 'specs/cache.md'), '---\ntitle: Cache policy\n---\nCache invalidation rules.');
  const indexer = new WikiIndexer({ workflowRoot, role: 'hermetic', includeCliSessions: false }); indexes.push(indexer);
  return { workflowRoot, indexer };
}
function config(workflowRoot: string, patch: Record<string, unknown> = {}) {
  writeFileSync(join(workflowRoot, 'search-providers.json'), JSON.stringify({ version: 1, providers: [{
    id: 'memory', enabled: true, kind: 'tencent-atomic', baseUrl: 'http://127.0.0.1:8123', apiKeyEnv: 'TENCENT_PROVIDER_TEST_KEY',
    serviceId: 'service', repoId, teamId: 'team', userId: 'user', agentId: 'agent', ...patch,
  }] }));
}
const atomic = () => ({ code: 0, data: { items: [{ id: 'one', type: 'instruction', content: 'External cache advice',
  version: 7, score: 0.9, team_id: 'team', user_id: 'user', agent_id: 'agent' }] } });
function appFor(initial: ReturnType<typeof context>) {
  let current = initial;
  const app = new Hono();
  registerSearchProviderRoutes(app, () => current, value => value === current);
  return { app, switchTo(value: typeof current) { current = value; } };
}
function post(app: Hono, body: unknown, path = '/api/wiki/search') {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const index of indexes.splice(0)) await index.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Dashboard explicit provider API', () => {
  it('defaults to local without touching external configuration or network', async () => {
    const ctx = context();
    writeFileSync(join(ctx.workflowRoot, 'search-providers.json'), 'invalid JSON ignored for local');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await post(appFor(ctx).app, { query: 'cache' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe('maestro-search/1.0');
    expect(body.results[0]).toMatchObject({ trust: 'local', kind: 'knowledge' });
    expect(body.mutationAuthorized).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('federates explicitly enabled remote hits without treating instructions as canonical specs', async () => {
    const ctx = context(); config(ctx.workflowRoot);
    vi.stubEnv('TENCENT_PROVIDER_TEST_KEY', 'test-only-key');
    const fetch = vi.fn(async () => Response.json(atomic())); vi.stubGlobal('fetch', fetch);
    const response = await post(appFor(ctx).app, { query: 'cache', providers: ['local', 'memory'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.map((hit: { ref: { providerId: string } }) => hit.ref.providerId)).toEqual(['local', 'memory']);
    expect(body.results[1]).toMatchObject({ trust: 'external', kind: 'memory', referenceOnly: true, ref: { version: '7' } });
    expect(body.results[1].ref.namespace).toMatch(/^tencent:/);
    expect(body.complete).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects disabled, unknown and mismatched bindings with no network', async () => {
    const ctx = context(); const { app } = appFor(ctx);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    config(ctx.workflowRoot, { enabled: false });
    expect((await post(app, { query: 'cache', providers: ['memory'] })).status).toBe(403);
    expect((await post(app, { query: 'cache', providers: ['unknown'] })).status).toBe(404);
    config(ctx.workflowRoot, { repoId: 'wrong-repository' });
    expect((await post(app, { query: 'cache', providers: ['memory'] })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps probes hermetic and rejects unsupported remote facets/modes before HTTP', async () => {
    const ctx = context(); const { app } = appFor(ctx);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    writeFileSync(join(ctx.workflowRoot, 'search-providers.json'), 'malformed');
    expect((await post(app, { query: 'cache', providers: ['memory'], readOnlyProbe: true })).status).toBe(403);
    expect((await post(app, { query: 'cache', providers: ['local'], readOnlyProbe: true })).status).toBe(200);
    config(ctx.workflowRoot);
    for (const controls of [{ filters: { type: 'spec' } }, { mode: 'hybrid' }]) {
      const response = await post(app, { query: 'cache', providers: ['memory'], ...controls });
      expect(response.status).toBe(502);
      expect((await response.json()).providers[0].code).toMatch(/^unsupported-/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes remote tenant violations and partial errors without leaking upstream data', async () => {
    const ctx = context(); config(ctx.workflowRoot); const { app } = appFor(ctx);
    vi.stubEnv('TENCENT_PROVIDER_TEST_KEY', 'test-only-key');
    vi.stubGlobal('fetch', vi.fn(async () => {
      const data = atomic(); data.data.items[0].team_id = 'other-team'; data.data.items[0].content = 'PRIVATE SENTINEL';
      return Response.json(data);
    }));
    const response = await post(app, { query: 'cache', providers: ['local', 'memory'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers[1].code).toBe('scope-mismatch');
    expect(body.results).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('PRIVATE SENTINEL');
    expect(JSON.stringify(body)).not.toContain('test-only-key');
  });

  it('resolves a wiki reference and rejects stale resource/config namespaces before another request', async () => {
    const ctx = context(); config(ctx.workflowRoot, { kind: 'tencent-wiki', knowledgeId: 'wiki-one' }); const { app } = appFor(ctx);
    vi.stubEnv('TENCENT_PROVIDER_TEST_KEY', 'test-only-key');
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ code: 0, data: request.tool_name === 'search'
        ? { results: [{ path: 'wiki/page.md', title: 'Page', snippet: 'preview', score: 1 }], count: 1 }
        : { items: [{ ref: 'wiki/page.md', content: 'Actual page source' }] } });
    }); vi.stubGlobal('fetch', fetch);
    const search = await (await post(app, { query: 'cache', providers: ['memory'] })).json();
    const read = await post(app, { ref: search.results[0].ref }, '/api/wiki/search/read');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ content: 'Actual page source', trust: 'external', mutationAuthorized: false });
    config(ctx.workflowRoot, { kind: 'tencent-wiki', knowledgeId: 'wiki-new' });
    expect((await post(app, { ref: search.results[0].ref }, '/api/wiki/search/read')).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never implements atomic reads by scanning a tenant or calling a write endpoint', async () => {
    const ctx = context(); config(ctx.workflowRoot); const { app } = appFor(ctx);
    vi.stubEnv('TENCENT_PROVIDER_TEST_KEY', 'test-only-key');
    const fetch = vi.fn(async () => Response.json(atomic())); vi.stubGlobal('fetch', fetch);
    const search = await (await post(app, { query: 'cache', providers: ['memory'] })).json();
    const response = await post(app, { ref: search.results[0].ref }, '/api/wiki/search/read');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('read-unsupported');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects caller tenant/authority/URL overrides, malformed payloads and oversized bodies', async () => {
    const { app } = appFor(context()); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const patch of [{ baseUrl: 'https://attacker.test' }, { authority: { repoId: 'forged' } }, { teamId: 'forged' },
      { providers: 'memory' }, { providers: [] }, { limit: 0 }, { mode: 'invalid' }, { readOnlyProbe: 'true' },
      { filters: { forbidden: 'value' } }, { query: 'x'.repeat(20_000) }]) {
      expect((await post(app, { query: 'cache', ...patch })).status).toBe(400);
    }
    const malformed = await app.request('/api/wiki/search', { method: 'POST', body: '{broken' });
    expect(malformed.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['/api/wiki/search', '/api/wiki/search/read'])('bounds a stalled %s body independently of body controls and slow cancellation', async path => {
    const ctx = context(); const { app } = appFor(ctx);
    const localSearch = vi.spyOn(ctx.indexer, 'searchWithMeta');
    const fetch = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', fetch);
    // Drive the native deadline deterministically instead of waiting five real seconds.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"timeoutMs":30000,')); },
      cancel,
    });
    const request = new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: stream, duplex: 'half' } as RequestInit);
    const pending = app.request(request);
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(5_000));
    deadline.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: 'timeout', mutationAuthorized: false });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(localSearch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['/api/wiki/search', '/api/wiki/search/read'])('cancels a stalled %s body when the client aborts even if cancellation rejects', async path => {
    const ctx = context(); const { app } = appFor(ctx);
    const localSearch = vi.spyOn(ctx.indexer, 'searchWithMeta');
    const fetch = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const cancel = vi.fn(async () => { throw new Error('private cancellation failure'); });
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: stream, signal: controller.signal, duplex: 'half' } as RequestInit);
    const pending = app.request(request);
    await Promise.resolve(); controller.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: 'aborted', mutationAuthorized: false });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(localSearch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['/api/wiki/search', '/api/wiki/search/read'])('rejects an already-aborted %s request even with a queued body', async path => {
    const ctx = context(); const { app } = appFor(ctx);
    const localSearch = vi.spyOn(ctx.indexer, 'searchWithMeta');
    const fetch = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); controller.abort();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ query: 'cache' }))); },
      cancel,
    });
    const request = new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: stream, signal: controller.signal, duplex: 'half' } as RequestInit);
    const response = await app.request(request);
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: 'aborted', mutationAuthorized: false });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(localSearch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discards a completed old-workspace response after workspace switch', async () => {
    const first = context(), next = context('22222222-2222-4222-8222-222222222222'); config(first.workflowRoot);
    const runtime = appFor(first);
    vi.stubEnv('TENCENT_PROVIDER_TEST_KEY', 'test-only-key');
    let finish!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; started(); })));
    const pending = post(runtime.app, { query: 'cache', providers: ['memory'] });
    await ready; runtime.switchTo(next); finish(Response.json(atomic()));
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'scope-mismatch', mutationAuthorized: false });
  });
});
