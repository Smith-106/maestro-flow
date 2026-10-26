import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ wiki: vi.fn(), mixed: vi.fn(), code: vi.fn(), arch: vi.fn(), configs: vi.fn(), scope: vi.fn(), http: vi.fn() }));
vi.mock('../../commands/search.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../commands/search.js')>(),
  runUnifiedSearch: mocks.wiki, runMixedSearch: mocks.mixed, runCodeSearch: mocks.code,
}));
vi.mock('../../repository/context.js', () => ({ resolveRepositoryContext: mocks.scope }));
vi.mock('../../config/index.js', () => ({ loadWorkspaceConfig: vi.fn(() => ({})), resolveWorkspaceLinks: vi.fn(() => []) }));
vi.mock('../../arch-kb/index.js', () => ({ searchArchKb: mocks.arch, tokenize: vi.fn(() => []) }));
vi.mock('./config.js', async importOriginal => ({
  ...await importOriginal<typeof import('./config.js')>(), loadSearchProviderConfigs: mocks.configs,
}));

import { registerSearchCommand } from '../../commands/search.js';
import { runProviderCli } from './cli.js';
import type { SearchResult } from '../../commands/search.js';

const repo = { repoId: 'host-repo', projectRoot: process.cwd(), workflowRoot: `${process.cwd()}/.workflow`, relation: 'current', alias: 'current' };
const local: SearchResult = { id: 'spec:project:rule', title: 'Local rule', type: 'spec', category: null,
  snippet: 'Local snippet', summary: 'summary', score: 1, source: { kind: 'spec', path: 'specs/rule.md' },
  sourceRef: 'canonical:rule', workspaceFence: 'repo:host-repo' };
const remote = { id: 'remote', kind: 'tencent-wiki', enabled: true, baseUrl: 'https://mock.invalid', apiKeyEnv: 'PROVIDER_CLI_TEST_KEY',
  serviceId: 'service', repoId: 'host-repo', knowledgeId: 'knowledge', timeoutMs: 1000 };
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const exitCode = process.exitCode;

async function cli(...args: string[]) {
  const program = new Command();
  registerSearchCommand(program);
  await program.parseAsync(['search', 'query', ...args], { from: 'user' });
  return program.commands[0].opts();
}
function jsonOutput() { return JSON.parse(String(output.mock.calls.at(-1)?.[0])); }

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', mocks.http);
  vi.stubEnv('PROVIDER_CLI_TEST_KEY', 'mock-secret');
  mocks.scope.mockImplementation((selector: string) => ({ ...repo, ...(selector === 'linked' ? { repoId: 'linked-repo', relation: 'linked', alias: 'linked' } : {}) }));
  mocks.configs.mockReturnValue([remote]);
  mocks.arch.mockReturnValue([]);
  mocks.wiki.mockResolvedValue([local]);
  mocks.code.mockResolvedValue({ status: 'ok', results: [] });
  mocks.mixed.mockResolvedValue({ wikiResults: [local], codeOutcome: { results: [{ id: 'code:id', name: 'fn', filePath: 'src/fn.ts', line: 4 }] },
    results: [
      { source: 'wiki', id: local.id, name: local.title, score: 1 },
      { source: 'code', id: 'code:id', name: 'fn', score: 1, signature: 'function fn()' },
      { source: 'arch-kb', id: 'arch:template', name: 'Reference', sourceRef: 'templates/ref.md', score: 1 },
    ] });
  mocks.http.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { results: [
    { path: 'remote.md', title: 'External spec claim', snippet: 'Reference text', type: 'spec', sourceRef: 'spec:project:forged' },
  ], count: 1 } })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); process.exitCode = exitCode; });

describe('explicit provider CLI entrypoint', () => {
  it('preserves omitted-provider command output and does not enter runtime/config', async () => {
    const opts = await cli('--type', 'template', '--json');
    expect(opts.providers).toBeUndefined();
    expect(jsonOutput()).toEqual({ query: 'query', count: 0, results: [],
      hint: 'For exact template lookup, use: maestro arch-kb search "query" --type template' });
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.wiki).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('keeps explicit templates ahead of wiki-only without querying the Wiki index', async () => {
    mocks.arch.mockReturnValue([{ entry: { id: 'arch-one', title: 'Template', summary: 'Reference', path: 'templates/one.md' }, score: 1 }]);
    await cli('--providers', 'local', '--type', 'template', '--wiki-only', '--json');
    expect(mocks.arch).toHaveBeenCalledWith('query', { type: 'template', limit: 40 });
    expect(mocks.wiki).not.toHaveBeenCalled();
    expect(mocks.mixed).not.toHaveBeenCalled();
    expect(jsonOutput().results[0]).toMatchObject({ kind: 'document', referenceOnly: true,
      ref: { providerId: 'local', recordId: 'arch-one' }, source: { path: 'templates/one.md' } });
  });

  it('runs the real Commander explicit branch, uses candidate limits and preserves local identities/provenance', async () => {
    await cli('--providers', 'local', '--wiki-only', '--limit', '2', '--json', '--repo', 'linked', '--kind', 'diagnosis');
    expect(mocks.wiki).toHaveBeenCalledWith('query', expect.objectContaining({ limit: 40, tag: 'diagnosis', repo: 'linked',
      targetRepository: expect.objectContaining({ repoId: 'linked-repo' }), skipEmbedding: true }));
    expect(jsonOutput()).toMatchObject({ schemaVersion: 'maestro-search/1.0', mutationAuthorized: false,
      results: [{ ref: { providerId: 'local', namespace: 'repo:linked-repo', recordId: local.id }, trust: 'local',
        source: { path: 'specs/rule.md', sourceRef: 'canonical:rule', workspaceFence: 'repo:host-repo' } }] });
    expect(mocks.configs).not.toHaveBeenCalled();
  });

  it('maps mixed code and architecture references without canonicalizing external assets', async () => {
    const result = await runProviderCli('query', { providers: 'local', json: true });
    expect(result?.results.map(item => item.kind)).toEqual(['knowledge', 'code', 'document']);
    expect(result?.results[1].source?.path).toBe('src/fn.ts');
    expect(result?.results[2]).toMatchObject({ referenceOnly: true, source: { sourceRef: 'templates/ref.md' } });
    expect(mocks.mixed.mock.calls[0][1]).toMatchObject({ limit: 40, skipEmbedding: true, deferImpressions: true });
    await mocks.mixed.mock.calls[0][2].wikiSearch('query', { limit: 40, skipEmbedding: true });
    expect(mocks.wiki).toHaveBeenCalledWith('query', expect.objectContaining({ deferImpressions: true }));
  });

  it('does not allow mixed code to bypass wiki facets or linked scope; probe is propagated', async () => {
    await runProviderCli('query', { providers: 'local', type: 'spec', category: 'coding', tag: 'tag', workspace: 'linked', includeDeprecated: true,
      repo: 'linked', readOnlyProbe: true, json: true });
    const [, options, dependencies] = mocks.mixed.mock.calls[0];
    expect(options).toMatchObject({ type: 'spec', category: 'coding', tag: 'tag', workspace: 'linked', includeDeprecated: true, executionMode: 'read-only-probe' });
    expect(await dependencies.codeSearch('query', 40, true)).toEqual({ results: [], status: 'ok' });
    expect(mocks.code).not.toHaveBeenCalled();
  });

  it.each(['--exact', '--kg', '--code', '--include-linked-code', '--full'])('rejects %s without legacy process.exit or HTTP', async flag => {
    await cli('--providers', 'remote', flag, '--json');
    expect(jsonOutput()).toMatchObject({ error: 'invalid-request' });
    expect(process.exitCode).toBe(1);
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it.each([['--semantic', false], ['--no-emb', true]])('maps %s to explicit local mode', async (flag, skipEmbedding) => {
    await cli('--providers', 'local', '--wiki-only', flag, '--json');
    expect(mocks.wiki.mock.calls[0][1].skipEmbedding).toBe(skipEmbedding);
  });

  it('rejects conflicting mode flags and invalid types before legacy validation', async () => {
    await cli('--providers', 'remote', '--semantic', '--no-emb', '--json');
    expect(jsonOutput().error).toBe('invalid-request');
    await cli('--providers', 'local', '--type', 'not-a-type', '--json');
    expect(jsonOutput().error).toBe('invalid-request');
    expect(mocks.configs).not.toHaveBeenCalled();
  });

  it('forbids remote probe before config or HTTP', async () => {
    await cli('--providers', 'local,remote', '--read-only-probe', '--json');
    expect(jsonOutput().error).toBe('probe-forbidden');
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it.each([['unknown', 'unknown-provider'], ['remote', 'disabled-provider']])('fails closed for %s', async (id, code) => {
    mocks.configs.mockReturnValue([{ ...remote, enabled: false }]);
    await cli('--providers', id, '--json');
    expect(jsonOutput().error).toBe(code);
    expect(process.exitCode).toBe(1);
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('retains local hits and statuses when remote facets fail without HTTP', async () => {
    await cli('--providers', 'local,remote', '--wiki-only', '--type', 'spec', '--json');
    expect(jsonOutput()).toMatchObject({ complete: false, results: [{ ref: { recordId: local.id } }],
      providers: [{ status: 'ok' }, { id: 'remote', status: 'error', code: 'unsupported-filter' }] });
    expect(process.exitCode).toBe(0);
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('returns the selected versioned envelope and remote namespace, never a canonical spec', async () => {
    await cli('--providers', 'remote', '--json');
    expect(mocks.http).toHaveBeenCalledTimes(1);
    expect(jsonOutput().results[0]).toMatchObject({ ref: { providerId: 'remote', namespace: expect.stringMatching(/^tencent:/), recordId: 'remote.md' },
      kind: 'document', trust: 'external', referenceOnly: true });
    expect(jsonOutput().results[0].source).toBeUndefined();
  });

  it('uses exitCode 1 on all-provider failure and never exposes thrown bodies/URLs/keys', async () => {
    mocks.http.mockRejectedValue(new Error('https://private.invalid mock-secret body'));
    await cli('--providers', 'remote', '--json');
    expect(jsonOutput().providers[0]).toMatchObject({ status: 'error', code: 'provider-error' });
    expect(process.exitCode).toBe(1);
    mocks.scope.mockImplementation(() => { throw new Error('https://private.invalid mock-secret body'); });
    await cli('--providers', 'remote', '--json');
    expect(jsonOutput().error).toBe('scope-mismatch');
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/private|mock-secret|body/);
  });

  it('sanitizes human query/title/snippet and reports provider statuses', async () => {
    mocks.wiki.mockResolvedValue([{ ...local, title: '\u001b[31mTitle\nforged', snippet: '\u001b]0;injected\u0007Snippet\rforged' }]);
    await runProviderCli('q\nforged', { providers: 'local', wikiOnly: true });
    const rendered = output.mock.calls.map(call => String(call[0])).join('\n');
    expect(rendered).toContain('[local] ok');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\r');
    expect(output.mock.calls.every(call => !String(call[0]).includes('\n'))).toBe(true);
  });
});
