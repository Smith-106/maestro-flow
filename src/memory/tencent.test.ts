import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createTencentMemoryAdapter } from './tencent.js';
import { createTencentProvider, createTencentTransport } from '../search/providers/tencent.js';
import type { TencentProviderConfig } from '../search/providers/config.js';
import { MemoryProjectionError, type MemoryAdapterContext } from '../../shared/memory-projection.js';

const config: TencentProviderConfig = { id: 'wiki', kind: 'tencent-wiki', enabled: true, writeEnabled: true,
  baseUrl: 'https://example.invalid', apiKeyEnv: 'KEY', serviceId: 'svc', repoId: 'repo', knowledgeId: 'kb',
  teamId: 'team', userId: 'user', agentId: 'agent', timeoutMs: 1000 };
const pageRef = `wiki/maestro/repo/${'a'.repeat(64)}.md`;
const content = '---\ntitle: Synthetic\nlocked: true\n---\nSynthetic body\n';
const hash = createHash('sha256').update(content).digest('hex');
const ready = { wiki_id: 'kb', team_id: 'team', status: 'ready' };
function context(patch: Partial<MemoryAdapterContext> = {}): MemoryAdapterContext {
  return { authority: { repoId: 'repo', workspaceFence: 'fence' }, executionMode: 'default',
    signal: new AbortController().signal, deadlineAt: Date.now() + 5000, ...patch };
}
function response(data: unknown) { return Response.json({ code: 0, data }); }
function setup(c = config) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const adapter = createTencentMemoryAdapter(c, { fetch, env: { KEY: 'synthetic-secret' } });
  return { adapter, fetch };
}
function body(fetch: ReturnType<typeof setup>['fetch'], index: number) { return JSON.parse(String(fetch.mock.calls[index][1]!.body)); }
async function code(promise: Promise<unknown>, expected: string) {
  await expect(promise).rejects.toMatchObject({ name: 'MemoryProjectionError', code: expected, message: expected });
}

describe('Tencent memory projections (synthetic HTTP only)', () => {
  it('shares the read provider namespace; asset identity is endpoint/service/wiki only', () => {
    const { adapter } = setup();
    expect(adapter.namespace).toBe(createTencentProvider(config).namespace);
    expect(adapter.assetKey).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.assetKey).toBe(createHash('sha256').update(JSON.stringify([
      config.baseUrl, config.serviceId, config.knowledgeId,
    ])).digest('hex'));
    for (const patch of [{ id: 'alias' }, { writeEnabled: false }, { enabled: false }, { teamId: 'other' },
      { userId: 'other' }, { agentId: 'other' }, { taskId: 'task' }, { repoId: 'other' },
      { timeoutMs: 5 }, { apiKeyEnv: 'OTHER' }, { baseUrl: `${config.baseUrl}/` }]) {
      expect(setup({ ...config, ...patch }).adapter.assetKey).toBe(adapter.assetKey);
    }
    for (const patch of [{ baseUrl: 'https://other.invalid' }, { serviceId: 'other' }, { knowledgeId: 'other' }]) {
      expect(setup({ ...config, ...patch }).adapter.assetKey).not.toBe(adapter.assetKey);
    }
    expect(setup({ ...config, writeEnabled: false }).adapter.namespace).toBe(adapter.namespace);
  });
  it('rejects atomic and invalid configs with sanitized memory errors', () => {
    expect(() => setup({ ...config, kind: 'tencent-atomic', writeEnabled: false })).toThrow('invalid-config');
    expect(() => setup({ ...config, baseUrl: 'http://not-loopback.invalid' })).toThrow('invalid-config');
  });
  it('asserts the configured wiki, team and ready state, without mutation', async () => {
    const { adapter, fetch } = setup(); fetch.mockResolvedValueOnce(response(ready));
    await adapter.assertReady(context());
    expect(fetch.mock.calls[0][0]).toBe(`${config.baseUrl}/v3/wiki/get`);
    expect(body(fetch, 0)).toEqual({ wiki_id: 'kb' });
  });
  it.each([
    [{ ...ready, status: 'draft' }, 'asset-not-ready'], [{ ...ready, status: 'processing' }, 'asset-not-ready'],
    [{ ...ready, status: undefined }, 'asset-not-ready'], [{ ...ready, wiki_id: 'other' }, 'scope-mismatch'],
    [{ ...ready, team_id: 'other' }, 'scope-mismatch'], [{ ...ready, team_id: undefined }, 'scope-mismatch'],
  ])('rejects nonready or wrong assets before mutation %j', async (data, expected) => {
    const { adapter, fetch } = setup(); fetch.mockImplementation(async () => response(data));
    await code(adapter.write(pageRef, content, context()), expected);
    await code(adapter.remove(pageRef, context()), expected);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${config.baseUrl}/v3/wiki/get`, `${config.baseUrl}/v3/wiki/get`]);
  });
  it('does not select an unconfigured team from the remote', async () => {
    const c = { ...config, writeEnabled: false }; delete c.teamId;
    const { adapter, fetch } = setup(c);
    await code(adapter.assertReady(context()), 'invalid-config');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads exact raw bytes, treats only explicit not_found as absent', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response({ items: [{ ref: pageRef, content }] }));
    expect(await adapter.read(pageRef, context())).toBe(content);
    expect(fetch.mock.calls[0][0]).toBe(`${config.baseUrl}/v3/wiki/page/read`);
    expect(body(fetch, 0)).toEqual({ wiki_id: 'kb', refs: [pageRef] });
    fetch.mockResolvedValueOnce(response({ items: [{ ref: pageRef, not_found: true }] }));
    expect(await adapter.read(pageRef, context())).toBeNull();
  });
  it.each([
    { items: [] }, { items: [null] }, { items: [{ ref: pageRef }] },
    { items: [{ ref: pageRef, content: 'x', not_found: true }] },
    { items: [{ ref: pageRef, content: 'x', not_found: 'false' }] },
    { items: [{ ref: pageRef, content: '\0' }] },
    { items: [{ ref: pageRef, content: '界'.repeat(87_382) }] },
    { items: [{ ref: pageRef, content }, { ref: pageRef, content }] },
  ])('rejects malformed or byte-oversized raw reads', async data => {
    const { adapter, fetch } = setup(); fetch.mockResolvedValue(response(data));
    await code(adapter.read(pageRef, context()), 'remote-response-invalid');
  });
  it('rejects a wrong raw-read ref and accepts the exact UTF8 byte ceiling', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response({ items: [{ ref: 'other.md', content }] }));
    await code(adapter.read(pageRef, context()), 'scope-mismatch');
    fetch.mockResolvedValueOnce(response({ items: [{ ref: pageRef, content: 'x'.repeat(262_144) }] }));
    expect(await adapter.read(pageRef, context())).toHaveLength(262_144);
  });
  it('writes only one attributed raw page after a fresh ready check; no read/search success is implied', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ items: [{ ref: pageRef, locked_injected: false }] }));
    await adapter.write(pageRef, content, context());
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${config.baseUrl}/v3/wiki/get`, `${config.baseUrl}/v3/wiki/page/write`]);
    expect(body(fetch, 1)).toEqual({ wiki_id: 'kb', team_id: 'team', user_id: 'user', agent_id: 'agent', pages: [{ ref: pageRef, content }] });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      Authorization: 'Bearer synthetic-secret', 'x-tdai-service-id': 'svc', 'Content-Type': 'application/json' } });
  });
  it.each([{}, { items: [] }, { items: [{ ref: pageRef }] }, { items: [{ ref: pageRef, locked_injected: 'false' }] }])('rejects malformed write acknowledgement without retry', async data => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response(data));
    await code(adapter.write(pageRef, content, context()), 'remote-response-invalid');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('awaits durable send preparation and reports the actual fetch invocation boundary', async () => {
    const { adapter, fetch } = setup(); const events: string[] = [];
    fetch.mockResolvedValueOnce(response(ready)).mockImplementationOnce(async () => {
      events.push('fetch'); return response({ items: [{ ref: pageRef, locked_injected: false }] });
    });
    await adapter.write(pageRef, content, { ...context(), beforeMutationSend: async () => { events.push('prepare'); },
      onMutationSend: () => { events.push('invoked'); } });
    expect(events).toEqual(['prepare', 'invoked', 'fetch']);
  });
  it('does not invoke mutation fetch if cancellation arrives during durable preparation', async () => {
    const { adapter, fetch } = setup(); const controller = new AbortController(); const invoked = vi.fn();
    fetch.mockResolvedValueOnce(response(ready));
    await code(adapter.write(pageRef, content, { ...context(), signal: controller.signal,
      beforeMutationSend: async () => { controller.abort(); }, onMutationSend: invoked }), 'aborted');
    expect(invoked).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports deletion cascade effects including upstream numeric rewrite count', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ deleted_pages: [pageRef, 'wiki/orphan.md'], rewritten_files: 3 }));
    expect(await adapter.remove(pageRef, context())).toEqual({ deletedPages: [pageRef, 'wiki/orphan.md'], rewrittenFiles: [], rewrittenFileCount: 3 });
    expect(fetch.mock.calls[1][0]).toBe(`${config.baseUrl}/v3/wiki/page/rm`);
    expect(body(fetch, 1)).toEqual({ wiki_id: 'kb', team_id: 'team', user_id: 'user', agent_id: 'agent', refs: [pageRef] });
  });
  it.each(['bare', 'prefix-only', 'suffix-only'])('accepts upstream short deletion refs (%s) and preserves exact reported effects', async form => {
    const { adapter, fetch } = setup();
    const short = form === 'bare' ? pageRef.replace(/^wiki\//, '').replace(/\.md$/, '')
      : form === 'prefix-only' ? pageRef.replace(/\.md$/, '') : pageRef.replace(/^wiki\//, '');
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ deleted_pages: [short], rewritten_files: 0 }));
    expect(await adapter.remove(pageRef, context())).toEqual({ deletedPages: [short], rewrittenFiles: [], rewrittenFileCount: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('also handles explicit bounded rewritten paths without inventing paths', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ deleted_pages: [pageRef], rewritten_files: ['wiki/other.md'] }));
    expect(await adapter.remove(pageRef, context())).toEqual({ deletedPages: [pageRef], rewrittenFiles: ['wiki/other.md'], rewrittenFileCount: 1 });
  });
  it.each([
    { deleted_pages: [pageRef], rewritten_files: -1 }, { deleted_pages: [pageRef], rewritten_files: 1.5 },
    { deleted_pages: [pageRef], rewritten_files: '1' }, { deleted_pages: [], rewritten_files: 0 },
    { deleted_pages: [pageRef, '../escape'], rewritten_files: 0 }, { deleted_pages: [pageRef, pageRef], rewritten_files: 0 },
    { deleted_pages: [pageRef], rewritten_files: ['../escape'] },
  ])('rejects malformed cascade reports', async data => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response(data));
    await code(adapter.remove(pageRef, context()), 'remote-response-invalid');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['paths', 'count'] as const)('bounds the complete %s effects JSON including numeric counts at exactly 16KiB', async kind => {
    const longPaths = Array.from({ length: 7 }, (_, i) => `${i}-${'x'.repeat(2046)}`);
    const effects = kind === 'paths'
      ? { deletedPages: [pageRef], rewrittenFiles: [...longPaths, 'last'], rewrittenFileCount: 8 }
      : { deletedPages: [pageRef, ...longPaths, 'last'], rewrittenFiles: [], rewrittenFileCount: Number.MAX_SAFE_INTEGER };
    const targets = kind === 'paths' ? effects.rewrittenFiles : effects.deletedPages;
    targets[targets.length - 1] += 'x'.repeat(16 * 1024 - Buffer.byteLength(JSON.stringify(effects), 'utf8'));
    expect(targets[targets.length - 1].length).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(effects), 'utf8')).toBe(16 * 1024);
    const { adapter, fetch } = setup();
    const data = () => ({ deleted_pages: effects.deletedPages,
      rewritten_files: kind === 'paths' ? effects.rewrittenFiles : effects.rewrittenFileCount });
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response(data()));
    expect(await adapter.remove(pageRef, context())).toEqual(effects);
    targets[targets.length - 1] += 'x';
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response(data()));
    await code(adapter.remove(pageRef, context()), 'remote-response-invalid');
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('measures cascade receipt size in UTF8 bytes, not characters, and never retries oversized effects', async () => {
    const deletedPages = [pageRef, ...Array.from({ length: 6 }, (_, i) => `${i}-${'界'.repeat(1000)}`)];
    const effects = { deletedPages, rewrittenFiles: [], rewrittenFileCount: 1 };
    expect(JSON.stringify(effects).length).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(effects), 'utf8')).toBeGreaterThan(16 * 1024);
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ deleted_pages: deletedPages, rewritten_files: 1 }));
    await code(adapter.remove(pageRef, context()), 'remote-response-invalid');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('verifies exact ref AND the existing read_page SHA256, never just title/snippet or raw storage', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response({ results: [{ path: pageRef, title: 'Synthetic', snippet: 'wrong snippet' }], count: 1 }))
      .mockResolvedValueOnce(response({ items: [{ ref: pageRef, content }] }));
    expect(await adapter.verifySearch(pageRef, 'Synthetic', hash, context())).toBe(true);
    expect(body(fetch, 0)).toEqual({ knowledge_id: 'kb', tool_name: 'search', params: { query: 'Synthetic', limit: 100 } });
    expect(body(fetch, 1)).toEqual({ knowledge_id: 'kb', tool_name: 'read_page', params: { refs: [pageRef] } });
    expect(fetch.mock.calls.every(call => call[0] === `${config.baseUrl}/v3/tools/call`)).toBe(true);
  });
  it.each(['miss', 'changed', 'missing'])('search verification is false for %s, never retries write', async scenario => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response({ results: [{ path: scenario === 'miss' ? 'wiki/other.md' : pageRef, title: 'Synthetic', snippet: content }], count: 1 }));
    if (scenario !== 'miss') fetch.mockResolvedValueOnce(response({ items: [{ ref: pageRef, ...(scenario === 'missing' ? { not_found: true } : { content: 'changed' }) }] }));
    expect(await adapter.verifySearch(pageRef, 'Synthetic', hash, context())).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(scenario === 'miss' ? 1 : 2);
  });
  it.each(['../escape', '/absolute', 'https://evil.invalid', 'a\\b', 'a//b', 'a/%2e%2e/b', 'a?x', 'a#x', 'a\n'])('rejects unsafe page ref %j before any HTTP', async path => {
    const { adapter, fetch } = setup();
    await code(adapter.read(path, context()), 'invalid-request');
    await code(adapter.write(path, content, context()), 'invalid-request');
    await code(adapter.remove(path, context()), 'invalid-request');
    await code(adapter.verifySearch(path, 'Synthetic', hash, context()), 'invalid-request');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces byte-bounded writes and strict verification arguments before HTTP', async () => {
    const { adapter, fetch } = setup();
    await code(adapter.write(pageRef, '界'.repeat(87_382), context()), 'source-too-large');
    await code(adapter.write(pageRef, '\0', context()), 'invalid-request');
    await code(adapter.verifySearch(pageRef, '', hash, context()), 'invalid-request');
    await code(adapter.verifySearch(pageRef, 'Synthetic', 'forged', context()), 'invalid-request');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [{ executionMode: 'read-only-probe' }, 'probe-forbidden'],
    [{ executionMode: 'unexpected' }, 'invalid-request'],
    [{ authority: { repoId: 'other', workspaceFence: 'fence' } }, 'scope-mismatch'],
    [{ authority: { repoId: 'repo', workspaceFence: '' } }, 'scope-mismatch'],
    [{ deadlineAt: 0 }, 'timeout'], [{ deadlineAt: NaN }, 'invalid-request'],
  ])('all methods enforce host/probe/deadline gates before credentials %j', async (patch, expected) => {
    const get = vi.fn(() => { throw new Error('must not read secret'); });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createTencentMemoryAdapter(config, { fetch, env: Object.defineProperty({}, 'KEY', { get }) });
    const ctx = context(patch as Partial<MemoryAdapterContext>);
    await code(adapter.assertReady(ctx), expected); await code(adapter.read(pageRef, ctx), expected);
    await code(adapter.write(pageRef, content, ctx), expected); await code(adapter.remove(pageRef, ctx), expected);
    await code(adapter.verifySearch(pageRef, 'Synthetic', hash, ctx), expected);
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('disabled and absent/false write switches block mutations before credentials; read remains usable', async () => {
    for (const patch of [{ enabled: false }, { writeEnabled: false }, {}]) {
      const c = { ...config, ...patch }; if (!Object.keys(patch).length) delete c.writeEnabled;
      const { adapter, fetch } = setup(c);
      const expected = c.enabled ? 'write-disabled' : 'disabled-provider';
      await code(adapter.write(pageRef, content, context()), expected); await code(adapter.remove(pageRef, context()), expected);
      expect(fetch).not.toHaveBeenCalled();
      if (c.enabled) {
        fetch.mockResolvedValueOnce(response({ items: [{ ref: pageRef, content }] }));
        expect(await adapter.read(pageRef, context())).toBe(content);
      }
    }
  });
  it('does not expose a configurable endpoint through the shared transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createTencentTransport(config, { fetch, env: { KEY: 'synthetic' } });
    await expect(transport.post('/v3/wiki/delete' as never, {}, context())).rejects.toMatchObject({ code: 'invalid-request' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['write', 'remove'] as const)('never retries %s after HTTP, network or malformed response failure', async method => {
    for (const failure of ['http', 'network', 'invalid']) {
      const { adapter, fetch } = setup(); fetch.mockResolvedValueOnce(response(ready));
      if (failure === 'http') fetch.mockResolvedValueOnce(new Response('secret remote body', { status: 503 }));
      else if (failure === 'network') fetch.mockRejectedValueOnce(new Error('secret remote URL'));
      else fetch.mockResolvedValueOnce(new Response('secret invalid JSON'));
      await code(method === 'write' ? adapter.write(pageRef, content, context()) : adapter.remove(pageRef, context()),
        failure === 'http' ? 'remote-http-error' : failure === 'network' ? 'provider-error' : 'remote-response-invalid');
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it('bounds ignored mutation fetch and streaming reads; cancellation is sanitized', async () => {
    const { adapter, fetch } = setup({ ...config, timeoutMs: 10 });
    fetch.mockResolvedValueOnce(response(ready)).mockImplementationOnce(() => new Promise(() => undefined));
    await code(adapter.write(pageRef, content, context()), 'timeout'); expect(fetch).toHaveBeenCalledTimes(2);
    const cancel = vi.fn(); fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    await code(adapter.read(pageRef, context()), 'timeout'); expect(cancel).toHaveBeenCalledOnce();
    const controller = new AbortController(); controller.abort();
    await code(adapter.remove(pageRef, context({ signal: controller.signal })), 'aborted'); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('accepts an exact 256KiB write and snapshots config rather than following caller mutation', async () => {
    const c = { ...config }; const { adapter, fetch } = setup(c);
    c.baseUrl = 'https://changed.invalid'; c.teamId = 'changed'; c.writeEnabled = false;
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ items: [{ ref: pageRef, locked_injected: false }] }));
    await adapter.write(pageRef, 'x'.repeat(262_144), context());
    expect(fetch.mock.calls[1][0]).toBe(`${config.baseUrl}/v3/wiki/page/write`);
    expect(body(fetch, 1).team_id).toBe('team'); expect(body(fetch, 1).pages[0].content).toHaveLength(262_144);
  });
  it('rechecks authority and cancellation between readiness and mutation send', async () => {
    for (const change of ['authority', 'abort'] as const) {
      const { adapter, fetch } = setup(); const controller = new AbortController();
      const ctx = context({ signal: controller.signal });
      fetch.mockImplementationOnce(async () => {
        if (change === 'authority') ctx.authority = { repoId: 'other', workspaceFence: 'fence' };
        else controller.abort();
        return response(ready);
      });
      await code(adapter.write(pageRef, content, ctx), change === 'authority' ? 'scope-mismatch' : 'aborted');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['write', 'remove'] as const)('revalidates live host authorization after readiness and immediately before %s send', async method => {
    const { adapter, fetch } = setup(); const events: string[] = [];
    fetch.mockImplementationOnce(async () => { events.push('ready'); return response(ready); });
    const assertMutationCurrent = vi.fn(() => {
      events.push('gate');
      throw new MemoryProjectionError('write-disabled');
    });
    const ctx = context({ assertMutationCurrent });
    await code(method === 'write' ? adapter.write(pageRef, content, ctx) : adapter.remove(pageRef, ctx), 'write-disabled');
    expect(events).toEqual(['ready', 'gate']); expect(assertMutationCurrent).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${config.baseUrl}/v3/wiki/get`);
  });
  it.each(['write', 'remove'] as const)('sends %s only after the live host gate succeeds', async method => {
    const { adapter, fetch } = setup(); const events: string[] = [];
    fetch.mockImplementationOnce(async () => { events.push('ready'); return response(ready); })
      .mockImplementationOnce(async () => { events.push('mutation'); return response(method === 'write'
        ? { items: [{ ref: pageRef, locked_injected: false }] } : { deleted_pages: [pageRef], rewritten_files: 0 }); });
    const ctx = context({ assertMutationCurrent: () => { events.push('gate'); } });
    if (method === 'write') await adapter.write(pageRef, content, ctx); else await adapter.remove(pageRef, ctx);
    expect(events).toEqual(['ready', 'gate', 'mutation']);
  });
  it('never invokes the mutation gate for readiness, raw reads or search verification', async () => {
    const { adapter, fetch } = setup();
    const assertMutationCurrent = vi.fn(() => { throw new Error('must not invoke on read'); });
    const ctx = context({ assertMutationCurrent });
    fetch.mockResolvedValueOnce(response(ready))
      .mockResolvedValueOnce(response({ items: [{ ref: pageRef, content }] }))
      .mockResolvedValueOnce(response({ results: [{ path: pageRef, title: 'Synthetic', snippet: '' }], count: 1 }))
      .mockResolvedValueOnce(response({ items: [{ ref: pageRef, content }] }));
    await adapter.assertReady(ctx); expect(await adapter.read(pageRef, ctx)).toBe(content);
    expect(await adapter.verifySearch(pageRef, 'Synthetic', hash, ctx)).toBe(true);
    expect(assertMutationCurrent).not.toHaveBeenCalled();
  });
  it('rejects wrong write refs and never interprets a retrieval error as searchable', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ items: [{ ref: 'other.md', locked_injected: false }] }));
    await code(adapter.write(pageRef, content, context()), 'scope-mismatch');
    fetch.mockResolvedValueOnce(new Response('secret', { status: 500 }));
    await code(adapter.verifySearch(pageRef, 'Synthetic', hash, context()), 'remote-http-error');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects oversized HTTP bodies before parsing and checks credentials without leaking them', async () => {
    const { adapter, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response('secret', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }));
    await code(adapter.read(pageRef, context()), 'response-too-large');
    const missing = createTencentMemoryAdapter(config, { fetch, env: {} });
    await code(missing.read(pageRef, context()), 'missing-credential'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
