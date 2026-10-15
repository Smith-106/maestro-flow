import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ daemon: vi.fn(), code: vi.fn(), unified: vi.fn(), openLinked: vi.fn(), templates: vi.fn(), exact: vi.fn() }));
vi.mock('../search/daemon-client.js', () => ({ tryDaemonSearch: mocks.daemon, readDaemonInfo: () => null, spawnDaemon: vi.fn() }));
// Keep best-effort impression persistence outside these presentation fixtures.
vi.mock('../graph/kg/credibility.js', () => ({ CredibilityStore: class {}, wikiIdToNodeId: (id: string) => id }));
vi.mock('../graph/kg/engine.js', () => ({ MaestroGraph: {
  isInitialized: () => false,
  openReadOnly: mocks.openLinked,
  open: async () => ({ searchCode: mocks.code, searchUnified: mocks.unified, close() {}, getStats: () => ({ nodesBySourceType: {} }) }),
} }));
vi.mock('../arch-kb/index.js', () => ({ searchArchKb: mocks.templates, tokenize: (q: string) => q.split(' ') }));
vi.mock('../search/exact-search.js', () => ({ runExactSearch: mocks.exact }));
import { MaestroGraph } from '../graph/kg/engine.js';
import { registerSearchCommand } from './search.js';
import { compactSearchPayload, linkedCodeWarnings, renderCompactSearch } from './search-presentation.js';

const cwd = process.cwd();
let root: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const wiki = { id: 'rule-400', type: 'knowhow', title: 'Useful rule', category: 'coding', summary: 'Useful summary',
  body: 'Preview body for query', tags: [], status: 'active', source: { kind: 'virtual', path: 'rules.md', alias: 'current' },
  parent: null, ext: {}, raw: {}, related: ['other'], appliesToRepoIds: null };
const code = { id: 'code:parse', kind: 'function', name: 'parse', filePath: 'C:/repo/src/parser.ts', startLine: 17,
  signature: 'function parse(input: string)', status: 'active', _bm25Score: 10 };
const template = { entry: { id: 'template-alpha', type: 'template', title: 'Alpha template', path: 'templates/alpha.md', summary: 'Reusable architecture pattern', keywords: ['query'] }, score: 9 };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'search-presentation-'));
  mkdirSync(join(root, '.workflow', 'kg'), { recursive: true });
  writeFileSync(join(root, '.workflow', 'kg', 'maestro.db'), '');
  process.chdir(root);
  vi.clearAllMocks();
  mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: [{ entry: wiki, score: 5 }], embeddingUsed: true, embeddingDocs: 99 });
  // Prime the mocked provider before concurrent mixed/detached usage imports.
  expect(MaestroGraph.isInitialized(root)).toBe(false);
  mocks.code.mockReturnValue([code]);
  mocks.templates.mockReturnValue([template]);
  mocks.unified.mockReturnValue({ directMatches: [{ node: { ...code, sourceType: 'codegraph', category: 'coding', definition: 'Parse input safely' }, score: 7 }] });
  mocks.openLinked.mockRejectedValue(new Error('linked database unavailable'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); process.exitCode = 0; });
async function action(args: string[]) {
  log.mockClear(); error.mockClear();
  const program = new Command(); registerSearchCommand(program);
  await program.parseAsync(['search', 'query', ...args], { from: 'user' });
  // Search schedules best-effort impression imports; settle them before the
  // next invocation or teardown can change cwd/provider mocks underneath them.
  await vi.dynamicImportSettled();
  return log.mock.calls.map(call => call.join(' ')).join('\n');
}

describe('compact CLI presentation', () => {
  it.each([['template', ['--type', 'template']], ['code', ['--code']], ['KG', ['--kg']], ['mixed', []], ['wiki', ['--wiki-only']]] as const)
  ('defaults %s JSON to compact and preserves full legacy fields', async (_label, args) => {
    const compact = JSON.parse(await action([...args, '--json']));
    const full = JSON.parse(await action([...args, '--json', '--full']));
    expect(compact.count, JSON.stringify({ compact, full })).toBe(full.count);
    expect(compact.results.map((r: { id: string }) => r.id)).toEqual(full.results.map((r: { id: string }) => r.id));
    expect(compact).not.toHaveProperty('wikiCount');
    expect(compact).not.toHaveProperty('summary');
    expect(compact.results.length).toBeGreaterThan(0);
    for (const result of compact.results) {
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('preview');
      for (const field of ['rank', 'score', 'detail', 'summary', 'snippet', 'signature', 'selectionReason', 'related', 'status']) expect(result).not.toHaveProperty(field);
    }
    expect(full.results[0]).toHaveProperty('score');
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)));
  });
  it.each([['--type', 'template'], ['--code'], ['--kg'], [], ['--wiki-only']])('prints compact human results without scores/embedding labels (%j)', async (...args) => {
    const text = await action(args);
    expect(text).not.toMatch(/\+emb|bm25|\(1\.0000\)|\(7\.0\)/);
    expect(text).toContain('result');
    expect(text).toMatch(/rule-400|code:parse|template-alpha/);
  });
  it.each([['--type', 'template'], ['--code'], ['--kg'], [], ['--wiki-only']])('retains full human score formatting (%j)', async (...args) => {
    expect(await action([...args, '--full'])).toMatch(/\((?:1|10)\.0000\)|\(7\.0\)/);
  });
  it('preserves legacy code JSON structure exactly with --full', async () => {
    expect(JSON.parse(await action(['--code', '--json', '--full']))).toEqual({
      query: 'query', count: 1, codeIndex: 'ok', results: [{ id: code.id, kind: code.kind, name: code.name,
        filePath: code.filePath, line: 17, score: 10, signature: code.signature, status: 'active' }],
    });
  });
  it('sanitizes actual compact human code output while preserving raw machine values', async () => {
    const name = '\u001b[2Jparse\r\nunsafe';
    mocks.code.mockReturnValue([{ ...code, name, signature: `function ${name}` }]);
    expect(JSON.parse(await action(['--code', '--json'])).results[0].name).toBe(name);
    const text = await action(['--code']);
    expect(text).not.toMatch(/[\u001b\r]/);
    expect(text).toContain('parse unsafe');
    expect(text).toContain('C:/repo/src/parser.ts:17');
    expect(text.split('\n')).toHaveLength(3);
  });
  it('retains code coordinates and template reference-only boundaries', async () => {
    const codeOutput = JSON.parse(await action(['--code', '--json']));
    expect(codeOutput.results[0]).toMatchObject({ source: 'code', filePath: code.filePath, line: 17 });
    const templates = JSON.parse(await action(['--type', 'template', '--json']));
    expect(templates.results[0]).toMatchObject({ referenceOnly: true, filePath: 'templates/alpha.md' });
  });
  it('keeps bounded diagnostics opt-in and independent of compact/full rendering', async () => {
    expect(JSON.parse(await action(['--code', '--json']))).not.toHaveProperty('diagnostics');
    for (const full of [[], ['--full']]) {
      const output = JSON.parse(await action(['--code', '--json', '--diagnostics', ...full]));
      expect(output.diagnostics.resultCount).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(output.diagnostics))).toBeLessThanOrEqual(16 * 1024);
    }
  });
  it('retains empty/degraded code hints in JSON and human modes', async () => {
    rmSync(join(root, '.workflow', 'kg', 'maestro.db'));
    const output = JSON.parse(await action(['--code', '--json']));
    expect(output).toMatchObject({ count: 0, results: [], hint: expect.stringContaining('maestro kg init') });
    expect(await action(['--code'])).toContain('maestro kg init');
    const full = JSON.parse(await action(['--code', '--json', '--full']));
    expect(full.codeIndex).toBe('not-initialized');
  });
  it.each([['--type', 'template'], ['--kg'], ['--wiki-only'], []])('handles empty output in compact and full modes (%j)', async (...args) => {
    mocks.templates.mockReturnValue([]); mocks.code.mockReturnValue([]); mocks.unified.mockReturnValue({ directMatches: [] });
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: [] });
    for (const full of [[], ['--full']]) expect(JSON.parse(await action([...args, '--json', ...full]))).toMatchObject({ count: 0, results: [] });
  });
  it('exposes partial linked failures even when useful local results exist', async () => {
    const linked = join(root, 'linked'); mkdirSync(join(linked, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({ workspaces: { linked: [{ name: 'library', path: linked, share: ['codebase'] }] } }));
    for (const args of [['--code'], ['--code', '--full'], [], ['--full']]) {
      const output = JSON.parse(await action([...args, '--include-linked-code', '--json']));
      expect(output.count).toBeGreaterThan(0);
      expect(output.warnings.join(' ')).toMatch(/library.*unavailable/);
      expect(await action([...args, '--include-linked-code'])).toMatch(/library.*unavailable/);
    }
  });
  it('shows exact timeout/completeness warnings even with no occurrences', async () => {
    mocks.exact.mockResolvedValue({ results: [], truncated: true, timedOut: true, bytesUsed: 0 });
    const text = await action(['--exact']);
    expect(text).toContain('truncated');
    expect(text).toContain('timed out; incomplete');
  });
  it('preserves exact JSON coordinates and completeness fields in either mode', async () => {
    const results = [{ filePath: 'src/x.ts', line: 3, column: 5, preview: 'query', workspace: 'linked' }];
    mocks.exact.mockResolvedValue({ results, truncated: true, timedOut: true, bytesUsed: 100 });
    for (const full of [[], ['--full']]) expect(JSON.parse(await action(['--exact', '--json', ...full]))).toEqual({ query: 'query', mode: 'exact', count: 1, truncated: true, timedOut: true, bytesUsed: 100, results });
  });
});

describe('presentation-only projection and terminal safety', () => {
  it('omits current/active/null metadata and keeps meaningful boundary/applicability/warnings', () => {
    const input = { query: 'q', count: 1, wikiCount: 1, results: [{ source: 'wiki', id: 'rule', kind: 'spec', name: 'Rule', detail: 'rule', rank: 1, score: 1,
      summary: 'Useful preview', snippet: 'Rule', alias: 'current', repoId: 'local-id', workspaceFence: 'repo:local-id', status: 'active', appliesToRepoIds: null }] };
    const before = JSON.stringify(input);
    expect(compactSearchPayload(input)).toEqual({ query: 'q', count: 1, results: [{ source: 'wiki', id: 'rule', kind: 'spec', name: 'Rule', preview: 'Useful preview' }] });
    expect(JSON.stringify(input)).toBe(before);
    Object.assign(input.results[0], { alias: 'library', workspace: 'library', confidence: 'contested', status: 'deprecated', appliesToRepoIds: ['target'] });
    expect(compactSearchPayload(input).results[0]).toMatchObject({ workspace: 'library', repoId: 'local-id', workspaceFence: 'repo:local-id', confidence: 'contested', status: 'deprecated', appliesToRepoIds: ['target'] });
  });
  it('sanitizes compact human text only, including OSC/CSI/C1, bidi, multiline names, identities and warnings', () => {
    const unsafe = '\u001b]8;;https://evil.test\u0007link\u001b]8;;\u001b\\\u001b[2J\u009b2K\r\nsecond\u202e';
    const payload = { query: unsafe, count: 1, warnings: [unsafe], results: [{ source: 'code', id: `code:${unsafe}`, kind: 'function', name: unsafe,
      filePath: `src/${unsafe}.ts`, line: 4, signature: `function ${unsafe}` }] };
    const compact = compactSearchPayload(payload);
    expect(compact.results[0].name).toBe(unsafe);
    const text = renderCompactSearch(compact).join('\n');
    expect(text).not.toMatch(/[\u001b\u0007\u009b\r\u202e]/);
    expect(text).not.toContain('https://evil.test');
    expect(text).toContain(':4');
    expect(text.split('\n')).toHaveLength(4);
  });
  it('bounds partial linked failure warnings and excludes raw driver errors', () => {
    const warnings = linkedCodeWarnings({ linkedFailures: Array.from({ length: 8 }, (_, i) => ({ workspace: `workspace-${i}` })) });
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('workspace-0');
    expect(warnings[3]).toBe('5 additional linked code workspaces unavailable');
  });
  it('bounds human names/previews without dropping stable identity', () => {
    const compact = compactSearchPayload({ query: 'q', count: 1, results: [{ source: 'wiki', id: 'stable-id', kind: 'spec', name: 'n'.repeat(200), summary: 's'.repeat(2000) }] });
    const lines = renderCompactSearch(compact);
    expect(lines.join('\n')).toContain('stable-id');
    expect(lines[1].length).toBeLessThan(180);
    expect(lines[2].length).toBeLessThan(250);
  });
});
