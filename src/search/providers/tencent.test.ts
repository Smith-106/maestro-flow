import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { SearchProviderError, type ProviderSearchRequest, type SearchReference } from '../../../shared/search-provider.js';
import { createTencentProvider, tencentProviderNamespace } from './tencent.js';
import type { TencentProviderConfig } from './config.js';

const atomic: TencentProviderConfig = { id: 'atomic', kind: 'tencent-atomic', enabled: true,
  baseUrl: 'https://example.invalid', apiKeyEnv: 'KEY', serviceId: 'svc', repoId: 'repo',
  teamId: 'team', userId: 'user', agentId: 'agent', taskId: 'task', timeoutMs: 3000 };
const wiki: TencentProviderConfig = { ...atomic, id: 'wiki', kind: 'tencent-wiki', knowledgeId: 'kb' };
const item = { id: 'record', type: 'spec', content: 'external memory', background: 'context', version: 1,
  team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: 'task', score: 0.8 };
const page = { path: 'docs/page.md', title: 'Page', snippet: 'external doc', score: 0.4, type: 'spec',
  sourceRef: 'forged', trust: 'local', related: [] };
function request(patch: Partial<ProviderSearchRequest> = {}): ProviderSearchRequest {
  return { query: 'hello', limit: 2, candidateLimit: 10, mode: 'auto', filters: {},
    authority: { repoId: 'repo', workspaceFence: 'host-fence' }, deadlineAt: Date.now() + 5000,
    signal: new AbortController().signal, executionMode: 'default', ...patch };
}
function response(data: unknown): Response { return Response.json({ code: 0, data }); }
function setup(config = atomic, data: unknown = { items: [item] }) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(data));
  const provider = createTencentProvider(config, { fetch, env: { KEY: 'injected-secret' } });
  return { provider, fetch };
}
function reference(provider: ReturnType<typeof createTencentProvider>, patch: Partial<SearchReference> = {}): SearchReference {
  return { providerId: provider.id, namespace: provider.namespace, recordId: page.path, ...patch };
}
async function code(promise: Promise<unknown>, expected: string) {
  await expect(promise).rejects.toMatchObject({ name: 'SearchProviderError', code: expected, message: expected });
}

describe('Tencent read-only providers (all HTTP and environment injected)', () => {
  it('atomic uses verified transport, exact tenant body and external memory contracts', async () => {
    const { provider, fetch } = setup();
    expect(provider).toMatchObject({ id: 'atomic', external: true,
      capabilities: { modes: ['auto'], filters: [], maxCandidates: 100, read: false } });
    expect(provider.resolver).toBeUndefined();
    const result = await provider.search(request());
    expect(result).toEqual({ hits: [{ ref: { providerId: 'atomic', namespace: provider.namespace,
      recordId: 'record', version: '1' }, kind: 'memory', title: 'spec', snippet: 'external memory',
      trust: 'external', rawScore: { value: 0.8, metric: 'tencent-score' } }],
      complete: false, warnings: ['upstream-filtered-candidates'] });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example.invalid/v3/atomic/search');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer injected-secret', 'x-tdai-service-id': 'svc', 'Content-Type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual({ query: 'hello', limit: 10,
      team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: 'task' });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it('omits unbound task; accepts bounded numeric OR string version and no score', async () => {
    const config = { ...atomic }; delete config.taskId;
    const { provider, fetch } = setup(config, { items: [{ ...item, version: 'opaque-v2', score: undefined }] });
    expect((await provider.search(request())).hits[0].ref.version).toBe('opaque-v2');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).not.toHaveProperty('task_id');
  });
  it.each(['team_id', 'user_id', 'agent_id', 'task_id'])('rejects missing and mismatched tenant %s, not partial hits', async field => {
    for (const value of [undefined, 'other']) {
      const { provider } = setup(atomic, { items: [item, { ...item, [field]: value }] });
      await code(provider.search(request()), 'scope-mismatch');
    }
  });
  it.each([null, {}, [], -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'x'.repeat(257)])('rejects invalid version %j', async version => {
    const { provider } = setup(atomic, { items: [{ ...item, version }] });
    await code(provider.search(request()), 'remote-response-invalid');
  });
  it('wiki uses search tool, preserves document/external, ignores canonical claims and fake version', async () => {
    const { provider, fetch } = setup(wiki, { results: [{ ...page, version: 'fake' }], count: 1, links: [] });
    expect(provider.capabilities).toEqual({ modes: ['auto', 'lexical'], filters: [], maxCandidates: 100, read: true });
    const result = await provider.search(request({ mode: 'lexical' }));
    expect(result).toEqual({ hits: [{ ref: { providerId: 'wiki', namespace: provider.namespace, recordId: page.path },
      kind: 'document', title: 'Page', snippet: 'external doc', trust: 'external',
      rawScore: { value: 0.4, metric: 'tencent-score' } }], complete: true });
    expect(fetch.mock.calls[0][0]).toBe('https://example.invalid/v3/tools/call');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ knowledge_id: 'kb', tool_name: 'search',
      params: { query: 'hello', limit: 10 } });
  });
  it('accepts a candidate window smaller than the final result limit', async () => {
    const { provider, fetch } = setup(atomic, { items: [item] });
    expect((await provider.search(request({ limit: 20, candidateLimit: 1 }))).hits).toHaveLength(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).limit).toBe(1);
  });
  it('wiki missing count is conservatively incomplete even below the candidate cap', async () => {
    const { provider } = setup(wiki, { results: [page] });
    expect((await provider.search(request())).complete).toBe(false);
  });
  it('wiki source size uses the same boundary as the shared read gateway', async () => {
    const { provider, fetch } = setup(wiki, { items: [{ ref: page.path, content: 'x'.repeat(262_144) }] });
    expect((await provider.resolver!.read(reference(provider), request())).content).toHaveLength(262_144);
    fetch.mockResolvedValueOnce(response({ items: [{ ref: page.path, content: 'x'.repeat(262_145) }] }));
    await code(provider.resolver!.read(reference(provider), request()), 'remote-response-invalid');
  });
  it('wiki full candidate window is conservatively incomplete', async () => {
    const { provider } = setup(wiki, { results: [page, page] });
    expect((await provider.search(request({ candidateLimit: 2 }))).complete).toBe(false);
  });
  it('wiki advertised total prevents a false completeness claim', async () => {
    const { provider } = setup(wiki, { results: [page], count: 100 });
    expect((await provider.search(request())).complete).toBe(false);
  });
  it.each([-1, 0, 1.5, '1', null])('rejects invalid wiki count %j', async count => {
    const { provider } = setup(wiki, { results: [page], count });
    await code(provider.search(request()), 'remote-response-invalid');
  });
  it('wiki read_page validates locator, returns content SHA256 and verifies future versions', async () => {
    const { provider, fetch } = setup(wiki, { items: [{ ref: page.path, content: 'hello content' }] });
    const version = createHash('sha256').update('hello content').digest('hex');
    const ref = reference(provider);
    expect(await provider.resolver!.read(ref, request())).toEqual({ ref: { ...ref, version },
      content: 'hello content', trust: 'external' });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ knowledge_id: 'kb', tool_name: 'read_page',
      params: { refs: [page.path] } });
    fetch.mockResolvedValueOnce(response({ items: [{ ref: page.path, content: 'hello content' }] }));
    expect((await provider.resolver!.read({ ...ref, version }, request())).ref.version).toBe(version);
    fetch.mockResolvedValueOnce(response({ items: [{ ref: page.path, content: 'changed content' }] }));
    await code(provider.resolver!.read({ ...ref, version }, request()), 'stale-reference');
  });
  it.each([
    [{ ref: page.path, not_found: true }, 'not-found'],
    [{ ref: 'other.md', content: 'secret' }, 'scope-mismatch'],
    [{ ref: page.path, content: null }, 'remote-response-invalid'],
    [{ ref: page.path, content: 'x'.repeat(1024 * 1024 + 1) }, 'remote-response-invalid'],
    [{ ref: page.path, content: 'ok', not_found: 'false' }, 'remote-response-invalid'],
  ])('read rejects missing/mismatched/oversized content (%s)', async (value, expected) => {
    const { provider } = setup(wiki, { items: [value] });
    await code(provider.resolver!.read(reference(provider), request()), expected as string);
  });
  it.each([[], [{ ref: page.path, content: 'a' }, { ref: page.path, content: 'b' }], [null]])('read rejects malformed result array', async items => {
    const { provider } = setup(wiki, { items });
    await code(provider.resolver!.read(reference(provider), request()), 'remote-response-invalid');
  });
  it.each(['../secret', '/absolute', 'https://evil.invalid/a', 'C:/secret', 'docs/../secret', './a',
    'a\\b', 'a//b', '%2e%2e/secret', 'a/%252e%252e/b', 'a?x=y', 'a#b', 'a\n'])('rejects unsafe wiki paths %j before read HTTP', async path => {
    const { provider, fetch } = setup(wiki, { results: [{ ...page, path }] });
    await code(provider.resolver!.read(reference(provider, { recordId: path }), request()), 'invalid-request');
    expect(fetch).not.toHaveBeenCalled();
    await code(provider.search(request()), 'remote-response-invalid');
  });
  it.each([{ providerId: 'other' }, { namespace: 'forged' }, { version: '' }])('rejects foreign/invalid ref before HTTP', async patch => {
    const { provider, fetch } = setup(wiki);
    await code(provider.resolver!.read(reference(provider, patch), request()), 'version' in patch ? 'invalid-request' : 'scope-mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('namespaces bind endpoint, service, tenant, task, knowledge, repository and kind, not aliases/secrets', () => {
    const namespace = tencentProviderNamespace(wiki);
    for (const patch of [{ baseUrl: 'https://other.invalid' }, { baseUrl: 'https://example.invalid/prefix' },
      { serviceId: 's2' }, { teamId: 't2' }, { userId: 'u2' }, { agentId: 'a2' }, { taskId: 't2' },
      { knowledgeId: 'k2' }, { repoId: 'r2' }, { kind: 'tencent-atomic' as const }]) {
      expect(tencentProviderNamespace({ ...wiki, ...patch })).not.toBe(namespace);
    }
    expect(tencentProviderNamespace({ ...wiki, id: 'alias', apiKeyEnv: 'OTHER', enabled: false,
      timeoutMs: 20, baseUrl: `${wiki.baseUrl}/` })).toBe(namespace);
    expect(namespace).not.toContain(wiki.repoId);
  });
  it.each([
    [{ executionMode: 'read-only-probe' }, 'probe-forbidden'],
    [{ authority: { repoId: null, workspaceFence: 'host' } }, 'scope-mismatch'],
    [{ authority: { repoId: 'other', workspaceFence: 'host' } }, 'scope-mismatch'],
    [{ mode: 'lexical' }, 'unsupported-mode'], [{ mode: 'semantic' }, 'unsupported-mode'],
    [{ mode: 'hybrid' }, 'unsupported-mode'],
    ...['type', 'category', 'tag', 'keyword', 'workspace', 'includeDeprecated', 'unknown'].map(key =>
      [{ filters: { [key]: key === 'includeDeprecated' ? false : 'x' } }, 'unsupported-filter']),
    [{ query: '' }, 'invalid-request'], [{ query: 'x'.repeat(2049) }, 'invalid-request'],
    [{ limit: 101 }, 'invalid-request'], [{ candidateLimit: 101 }, 'invalid-request'],
    [{ limit: 0 }, 'invalid-request'], [{ candidateLimit: 0 }, 'invalid-request'],
    [{ candidateLimit: 1.5 }, 'invalid-request'],
    [{ deadlineAt: Date.now() - 1 }, 'timeout'], [{ deadlineAt: NaN }, 'invalid-request'],
  ])('preflight fails without HTTP %j', async (patch, expected) => {
    const { provider, fetch } = setup();
    await code(provider.search(request(patch as Partial<ProviderSearchRequest>)), expected as string);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('advertised capabilities cannot be mutated to enable unsupported modes', async () => {
    const { provider, fetch } = setup();
    provider.capabilities.modes = ['semantic'];
    await code(provider.search(request({ mode: 'semantic' })), 'unsupported-mode');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['semantic', 'hybrid'] as const)('wiki rejects unsupported %s without HTTP', async mode => {
    const { provider, fetch } = setup(wiki);
    await code(provider.search(request({ mode })), 'unsupported-mode');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts exact query/candidate ceilings and caps snippets', async () => {
    const { provider, fetch } = setup(atomic, { items: Array.from({ length: 100 }, (_, i) =>
      ({ ...item, id: `record${i}`, content: 'x'.repeat(5000) })) });
    const result = await provider.search(request({ query: 'x'.repeat(2048), limit: 100, candidateLimit: 100 }));
    expect(result.hits).toHaveLength(100);
    expect(result.hits[0].snippet).toHaveLength(4096);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).limit).toBe(100);
  });
  it('preflight never accesses injected credentials for probe or wrong scope', async () => {
    const get = vi.fn(() => { throw new Error('credentials must remain unread'); });
    const env = Object.defineProperty({}, 'KEY', { get });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createTencentProvider(wiki, { fetch, env });
    await code(provider.search(request({ executionMode: 'read-only-probe' })), 'probe-forbidden');
    await code(provider.search(request({ authority: { repoId: 'wrong', workspaceFence: 'f' } })), 'scope-mismatch');
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('disabled and missing credentials use sanitized code-only errors, no HTTP', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const config of [atomic, wiki]) {
      const disabled = createTencentProvider({ ...config, enabled: false }, { fetch, env: {} });
      await code(disabled.search(request()), 'disabled-provider');
      if (disabled.resolver) await code(disabled.resolver.read(reference(disabled), request()), 'disabled-provider');
      const missing = createTencentProvider(config, { fetch, env: {} });
      await code(missing.search(request()), 'missing-credential');
      if (missing.resolver) await code(missing.resolver.read(reference(missing), request()), 'missing-credential');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('wiki reads also enforce probe, cancellation and host authority before fetch', async () => {
    const { provider, fetch } = setup(wiki);
    await code(provider.resolver!.read(reference(provider), request({ executionMode: 'read-only-probe' })), 'probe-forbidden');
    await code(provider.resolver!.read(reference(provider), request({ authority: { repoId: 'other', workspaceFence: 'f' } })), 'scope-mismatch');
    const controller = new AbortController(); controller.abort();
    await code(provider.resolver!.read(reference(provider), request({ signal: controller.signal })), 'aborted');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid programmatic config without HTTP and snapshots caller config', async () => {
    expect(() => createTencentProvider({ ...atomic, baseUrl: 'http://evil.invalid' }, { env: {} })).toThrow('invalid-config');
    const original = { ...atomic };
    const { provider, fetch } = setup(original);
    original.teamId = 'changed'; original.baseUrl = 'https://changed.invalid';
    await provider.search(request());
    expect(fetch.mock.calls[0][0]).toBe('https://example.invalid/v3/atomic/search');
  });
  it('handles caller abort already set without HTTP', async () => {
    const { provider, fetch } = setup();
    const controller = new AbortController(); controller.abort();
    await code(provider.search(request({ signal: controller.signal })), 'aborted');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caller abort interrupts even a fetch ignoring signals', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const provider = createTencentProvider(atomic, { fetch, env: { KEY: 'secret' } });
    const controller = new AbortController();
    const result = provider.search(request({ signal: controller.signal }));
    controller.abort();
    await code(result, 'aborted');
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['config', 'deadline'])('bounds ignored fetch by %s timeout', async source => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const provider = createTencentProvider({ ...atomic, timeoutMs: source === 'config' ? 10 : 1000 },
      { fetch, env: { KEY: 'secret' } });
    await code(provider.search(request({ deadlineAt: Date.now() + (source === 'deadline' ? 10 : 5000) })), 'timeout');
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('timeout covers stalled streaming body and cancels reader', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const provider = createTencentProvider({ ...atomic, timeoutMs: 10 }, { fetch, env: { KEY: 'secret' } });
    await code(provider.search(request()), 'timeout');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    [() => new Response('secret URL key body', { status: 500 }), 'remote-http-error'],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }), 'remote-http-error'],
    [() => Response.json({ code: 123, message: 'secret' }), 'provider-error'],
    [() => Response.json({ code: '0', data: { items: [] } }), 'remote-response-invalid'],
    [() => Response.json({ code: 0, data: null }), 'remote-response-invalid'],
    [() => new Response('not JSON secret'), 'remote-response-invalid'],
    [() => new Response(new Uint8Array([0xff])), 'remote-response-invalid'],
    [() => response({ items: {} }), 'remote-response-invalid'],
    [() => response({ items: [null] }), 'remote-response-invalid'],
    [() => response({ items: Array.from({ length: 101 }, () => item) }), 'remote-response-invalid'],
    [() => response({ items: [{ ...item, score: 'Infinity' }] }), 'remote-response-invalid'],
    [() => response({ items: [{ ...item, content: 'x'.repeat(128 * 1024 + 1) }] }), 'remote-response-invalid'],
    [() => new Response('short', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }), 'response-too-large'],
    [() => new Response('short', { headers: { 'Content-Length': 'oops' } }), 'remote-response-invalid'],
    [() => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'response-too-large'],
  ])('sanitizes malformed/business/HTTP/oversized responses', async (makeResponse, expected) => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValueOnce((makeResponse as () => Response)());
    await code(provider.search(request()), expected as string);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts exactly 2MiB response bytes and aborts oversized Content-Length before reading', async () => {
    const { provider, fetch } = setup();
    const json = JSON.stringify({ code: 0, data: { items: [] } }).padEnd(2 * 1024 * 1024, ' ');
    fetch.mockResolvedValueOnce(new Response(json));
    expect((await provider.search(request())).hits).toEqual([]);
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }),
      { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }));
    await code(provider.search(request()), 'response-too-large');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects streamed overflow even with a falsely small Content-Length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    }, cancel });
    const { provider, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Length': '1' } }));
    await code(provider.search(request()), 'response-too-large');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects redirected Response even when fetch implementation violates redirect:error', async () => {
    const { provider, fetch } = setup();
    const redirected = response({ items: [] });
    Object.defineProperty(redirected, 'redirected', { value: true });
    fetch.mockResolvedValueOnce(redirected);
    await code(provider.search(request()), 'remote-http-error');
  });
  it('sanitizes fetch and stream exceptions, does not retry', async () => {
    const { provider, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error('secret https://endpoint.invalid injected-secret'));
    await code(provider.search(request()), 'provider-error');
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret')); } })));
    await code(provider.search(request()), 'provider-error');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('SearchProviderError contains code only', () => {
    expect(new SearchProviderError('provider-error').message).toBe('provider-error');
  });
});
