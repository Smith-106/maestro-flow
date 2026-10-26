import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ wiki: vi.fn(), configs: vi.fn(), scope: vi.fn(), http: vi.fn(), root: vi.fn(), exists: vi.fn(), daemon: vi.fn() }));
vi.mock('../../commands/search.js', () => ({ runUnifiedSearch: mocks.wiki }));
vi.mock('../../repository/context.js', () => ({ resolveRepositoryContext: mocks.scope }));
vi.mock('../../config/index.js', () => ({ loadWorkspaceConfig: vi.fn(() => ({})), resolveWorkspaceLinks: vi.fn(() => []) }));
vi.mock('../../utils/path-validator.js', () => ({ getProjectRoot: mocks.root }));
vi.mock('../../search/daemon-client.js', () => ({ tryDaemonSearch: mocks.daemon, spawnDaemon: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: mocks.exists }));
vi.mock('./config.js', async importOriginal => ({
  ...await importOriginal<typeof import('./config.js')>(), loadSearchProviderConfigs: mocks.configs,
}));

import { handler, schema } from '../../tools/wiki-search.js';
import { runProviderMcp } from './mcp.js';

const hostRoot = resolve('host-project');
const repo = { repoId: 'host-repo', projectRoot: hostRoot, workflowRoot: resolve(hostRoot, '.workflow'), relation: 'current', alias: 'current' };
const remote = { id: 'remote', kind: 'tencent-wiki', enabled: true, baseUrl: 'https://mock.invalid', apiKeyEnv: 'PROVIDER_MCP_TEST_KEY',
  serviceId: 'service', repoId: 'host-repo', knowledgeId: 'knowledge', timeoutMs: 1000 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.root.mockReturnValue(hostRoot);
  mocks.exists.mockReturnValue(false);
  mocks.scope.mockImplementation((selector: string) => ({ ...repo,
    ...(selector === 'linked' ? { repoId: 'linked-repo', relation: 'linked', alias: 'linked' } : {}) }));
  mocks.configs.mockReturnValue([remote]);
  mocks.wiki.mockResolvedValue([{ id: 'spec:project:rule', title: 'Rule', snippet: 'Local snippet', summary: 'Summary', score: 1,
    sourceRef: 'canonical:rule', source: { path: 'specs/rule.md', workspaceFence: 'repo:host-repo' } }]);
  vi.stubGlobal('fetch', mocks.http);
  vi.stubEnv('PROVIDER_MCP_TEST_KEY', 'mock-secret');
  mocks.http.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { results: [
    { path: 'remote.md', title: 'External', snippet: 'Untrusted', type: 'spec', sourceRef: 'spec:project:forged' },
  ], count: 1 } })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('explicit provider MCP entrypoint', () => {
  it('adds only optional provider selection and retains the original omitted-provider empty-workflow path', async () => {
    expect(schema.inputSchema.properties.providers).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(schema.inputSchema.required).toEqual(['query']);
    for (const key of ['type', 'category', 'tag', 'keyword', 'workspace']) {
      expect(schema.inputSchema.properties[key]).toMatchObject({ type: 'string' });
    }
    expect(schema.inputSchema.properties.includeDeprecated).toMatchObject({ type: 'boolean' });
    expect(schema.inputSchema.properties.readOnlyProbe).toMatchObject({ type: 'boolean' });
    expect(await handler({ query: 'query' })).toEqual({ success: true, result: { results: [], embeddingUsed: false, totalResults: 0 } });
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.wiki).not.toHaveBeenCalled();
    expect(mocks.daemon).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('branches before workflow/daemon checks and uses the host root rather than caller authority', async () => {
    const result = await handler({ query: 'query', providers: ['local'], limit: 2 });
    expect(result).toMatchObject({ success: true, result: { schemaVersion: 'maestro-search/1.0', mutationAuthorized: false,
      results: [{ ref: { providerId: 'local', recordId: 'spec:project:rule', namespace: 'repo:host-repo' },
        source: { path: 'specs/rule.md', sourceRef: 'canonical:rule', workspaceFence: 'repo:host-repo' } }] } });
    expect(mocks.scope).toHaveBeenCalledWith('current', { projectRoot: hostRoot });
    expect(mocks.wiki).toHaveBeenCalledWith('query', expect.objectContaining({ limit: 40, projectRoot: hostRoot, skipEmbedding: true }));
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.daemon).not.toHaveBeenCalled();
    expect(mocks.configs).not.toHaveBeenCalled();
  });

  it('rejects caller authority/endpoint fields and supports an explicitly requested local probe without providers', async () => {
    for (const patch of [{ projectRoot: '/attacker' }, { tenantId: 'attacker' }, { baseUrl: 'https://attacker.test' }]) {
      expect(await handler({ query: 'query', providers: ['local'], ...patch })).toEqual({ success: false, error: 'invalid-request' });
    }
    expect(mocks.wiki).not.toHaveBeenCalled();
    expect(await handler({ query: 'query', type: 'spec' })).toEqual({ success: false, error: 'invalid-request' });
    const result = await handler({ query: 'query', readOnlyProbe: true });
    expect(result.success).toBe(true);
    expect(mocks.wiki).toHaveBeenCalledWith('query', expect.objectContaining({ executionMode: 'read-only-probe', deferImpressions: true }));
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.daemon).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it.each([
    [{}, true], [{ semantic: false }, true], [{ semantic: true }, false],
    [{ skipEmbedding: false }, false], [{ skipEmbedding: true }, true],
  ])('translates explicit mode controls %j', async (controls, skipEmbedding) => {
    expect((await handler({ query: 'query', providers: ['local'], ...controls })).success).toBe(true);
    expect(mocks.wiki.mock.calls[0][1].skipEmbedding).toBe(skipEmbedding);
  });

  it('passes local repo selection and facets through the scoped callback', async () => {
    const result = await runProviderMcp({ query: 'query', providers: ['local'], repo: 'linked', type: 'spec', category: 'coding',
      tag: 'tag', workspace: 'linked', includeDeprecated: true }, hostRoot);
    expect(result.success).toBe(true);
    expect(mocks.wiki).toHaveBeenCalledWith('query', expect.objectContaining({ repo: 'linked',
      targetRepository: expect.objectContaining({ repoId: 'linked-repo' }), type: 'spec', category: 'coding', tag: 'tag', workspace: 'linked', includeDeprecated: true }));
  });

  it('rejects remote probe before config and HTTP, without falling back to legacy search', async () => {
    expect(await handler({ query: 'query', providers: ['remote'], executionMode: 'read-only-probe' }))
      .toEqual({ success: false, error: 'probe-forbidden' });
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
    expect(mocks.daemon).not.toHaveBeenCalled();
  });

  it.each([['missing', 'unknown-provider'], ['remote', 'disabled-provider']])('rejects %s without HTTP', async (id, code) => {
    mocks.configs.mockReturnValue([{ ...remote, enabled: false }]);
    expect(await handler({ query: 'query', providers: [id] })).toEqual({ success: false, error: code });
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('rejects unsupported remote facets without HTTP while retaining local hits', async () => {
    const result = await runProviderMcp({ query: 'query', providers: ['local', 'remote'], tag: 'tag' }, hostRoot);
    expect(result).toMatchObject({ success: true, result: { complete: false, results: [{ ref: { providerId: 'local' } }],
      providers: [{ status: 'ok' }, { id: 'remote', status: 'error', code: 'unsupported-filter' }] } });
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('reports all-provider failure as success:false with sanitized codes', async () => {
    mocks.http.mockRejectedValue(new Error('private response body https://secret.invalid mock-secret'));
    const result = await handler({ query: 'query', providers: ['remote'] });
    expect(result).toMatchObject({ success: false, error: 'provider-error', result: { providers: [{ code: 'provider-error', status: 'error' }] } });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|body/);
  });

  it('keeps remote records external, namespaced and reference-only despite a spec claim', async () => {
    const result = await handler({ query: 'query', providers: ['remote'] });
    expect(result).toMatchObject({ success: true, result: { results: [{ ref: { providerId: 'remote', recordId: 'remote.md', namespace: expect.stringMatching(/^tencent:/) },
      kind: 'document', trust: 'external', referenceOnly: true }] } });
    expect(mocks.wiki).not.toHaveBeenCalled();
    expect(mocks.http).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('spec:project:forged');
  });

  it.each([
    { providers: 'local' }, { providers: [] }, { providers: ['local', 'local'] }, { providers: ['local'], limit: 0 },
    { providers: ['local'], semantic: true, skipEmbedding: true }, { providers: ['local'], repo: 42 },
  ])('fails closed for invalid request %j', async params => {
    expect(await handler({ query: 'query', ...params })).toEqual({ success: false, error: 'invalid-request' });
    expect(mocks.http).not.toHaveBeenCalled();
    expect(mocks.wiki).not.toHaveBeenCalled();
  });

  it('sanitizes global exceptions without returning repository paths or thrown URLs/keys', async () => {
    mocks.scope.mockImplementation(() => { throw new Error('https://secret.invalid private body mock-secret'); });
    expect(await handler({ query: 'query', providers: ['remote'] })).toEqual({ success: false, error: 'scope-mismatch' });
    expect(mocks.http).not.toHaveBeenCalled();
  });
});
