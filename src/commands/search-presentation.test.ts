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
import { compactSearchPayload, knowledgeCaptureHint, linkedCodeWarnings, renderCompactSearch } from './search-presentation.js';

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
async function action(args: string[], query = 'query') {
  log.mockClear(); error.mockClear();
  const program = new Command(); registerSearchCommand(program);
  await program.parseAsync(['search', query, ...args], { from: 'user' });
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
  it('preserves full code JSON fields with additive local coverage', async () => {
    expect(JSON.parse(await action(['--code', '--json', '--full']))).toEqual({
      query: 'query', count: 1, codeIndex: 'ok', localStatus: 'ok', results: [{ id: code.id, kind: code.kind, name: code.name,
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
  it.each([['--type', 'template'], []])('keeps one actionable compact template route (%j)', async (...args) => {
    const compact = JSON.parse(await action([...args, '--json']));
    const row = compact.results.find((result: { source: string }) => result.source === 'arch-kb');
    expect(row).toMatchObject({ openCommand: 'maestro load --type template --id template-alpha' });
    for (const field of ['detail', 'searchCommand', 'rank', 'score']) expect(row).not.toHaveProperty(field);
    expect(compact.results.filter((result: { source: string }) => result.source !== 'arch-kb').every((result: object) => !('openCommand' in result))).toBe(true);
    const text = await action(args);
    expect(text.match(/maestro load --type template --id template-alpha/g)).toHaveLength(1);
    expect(text).not.toContain('maestro arch-kb search');
  });
  it.each([['--code'], []])('displays stable linked fences in actual compact output (%j)', async (...args) => {
    mocks.code.mockReturnValue([{ ...code, metadata: { fixtureWorkspace: 'library', fixtureWorkspaceFence: 'repo:stable-library' } }]);
    expect(await action(args)).toContain('[@library; repo:stable-library]');
    expect(JSON.parse(await action([...args, '--json'])).results.find((result: { source: string }) => result.source === 'code'))
      .toMatchObject({ workspace: 'library', workspaceFence: 'repo:stable-library' });
  });
  it.each([['template', ['--type', 'template']], ['code', ['--code']], ['KG', ['--kg']], ['mixed', []], ['wiki', ['--wiki-only']]] as const)
  ('sanitizes compact/full human %s fields and query without changing raw JSON', async (_label, args) => {
    const attack = '\u001b]8;;https://evil.test\u0007x\u001b]8;;\u001b\\\u001b[2J\u009b2K\r\u0000\u202e\u2066';
    const name = `unsafe${attack}name`;
    const badCode = { ...code, id: `code:${name}`, kind: `function${attack}`, name, filePath: `src/${name}.ts`, signature: `signature ${name}`,
      metadata: { fixtureWorkspace: `library${attack}`, fixtureWorkspaceFence: `repo:${name}` } };
    mocks.code.mockReturnValue([badCode]);
    mocks.unified.mockReturnValue({ directMatches: [{ node: { ...badCode, sourceType: `codegraph${attack}`, category: 'coding', definition: `definition ${name}` }, score: 7 }] });
    mocks.templates.mockReturnValue([{ ...template, entry: { ...template.entry, id: name, title: name, path: `templates/${name}.md`, summary: `summary ${name}` } }]);
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: [{ entry: { ...wiki, id: name, title: name, type: `knowhow${attack}`, category: `coding${attack}`, summary: `summary ${name}`, body: `query snippet ${name}` }, score: 5 }] });
    for (const mode of [[], ['--full']]) {
      const json = JSON.parse(await action([...args, ...mode, '--json'], `query${attack}`));
      expect(json.query).toBe(`query${attack}`);
      expect(json.results.length).toBeGreaterThan(0);
      expect(json.results.some((result: { name: string }) => result.name === name)).toBe(true);
      for (const result of json.results) {
        expect(result.id).toContain(name);
        if (result.openCommand) expect(result.openCommand).toContain(name);
        if (result.filePath) expect(result.filePath).toContain(name);
        if (result.workspaceFence) expect(result.workspaceFence).toContain(name);
        if (result.detail) expect(result.detail).toContain(name);
        expect(result.preview ?? result.signature ?? result.definition ?? result.snippet ?? result.summary).toContain(attack);
      }
      const text = await action([...args, ...mode], `fix query${attack}`);
      expect(text).toContain('unsafe');
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      expect(text).not.toContain('https://evil.test');
      expect(text.split('\n').slice(1).every(line => line.startsWith('  '))).toBe(true);
    }
  });
  it('preserves plain full headers, spacing, scores and template destinations', async () => {
    expect(await action(['--code', '--full'])).toBe('Search: "query" (code 1, bm25)\n  [function] parse  C:/repo/src/parser.ts:17  function parse(input: string)  (10.0000)');
    expect(await action(['--type', 'template', '--full'])).toBe('Search: "query" (template 1 results)\n  Hint: For exact template lookup, use: maestro arch-kb search "query" --type template\n  [arch-kb:template] [reference only; not current project]  Alpha template  templates/alpha.md  (maestro load --type template --id template-alpha)  (1.0000)\n    Reusable architecture pattern');
    expect(await action(['--wiki-only', '--full'])).toBe(`Search: "query" (knowhow 1 = 1 results, +emb(99))\n  Capture: ${knowledgeCaptureHint(1, 20)}\n  [wiki:knowhow]  Useful rule  coding  rule-400  (1.0000)\n    L1: Preview body for query`);
    expect(await action(['--kg', '--full'])).toBe(`Search: "query" (codegraph 1 = 1, KG)\n  Capture: ${knowledgeCaptureHint(0, 20)}\n  [codegraph:function]  code:parse  parse  Parse input safely  (7.0)`);
  });
  it('preserves full content spacing as well as renderer indentation', async () => {
    mocks.code.mockReturnValue([{ ...code, signature: 'function parse(a:  string)' }]);
    mocks.templates.mockReturnValue([{ ...template, entry: { ...template.entry, summary: '  Reference  detail  ' } }]);
    expect(await action(['--code', '--full'])).toContain('  function parse(a:  string)  (10.0000)');
    expect(await action(['--type', 'template', '--full'])).toContain('\n      Reference  detail  ');
  });
  it('keeps raw template command examples in machine hints', async () => {
    mocks.templates.mockReturnValue([]);
    const query = 'query\u001b[2J\u202e';
    expect(JSON.parse(await action(['--type', 'template', '--json'], query)).hint)
      .toBe(`For exact template lookup, use: maestro arch-kb search ${JSON.stringify(query)} --type template`);
    expect(await action(['--type', 'template', '--full'], query)).not.toMatch(/[\u001b\u202e]/);
  });
  it.each([['--code'], ['--kg'], ['--wiki-only'], ['--type', 'template'], []])('sanitizes before trusted full TTY highlighting (%j)', async (...args) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      const name = 'query\u001b[2J\u202e';
      mocks.code.mockReturnValue([{ ...code, name }]);
      mocks.unified.mockReturnValue({ directMatches: [{ node: { ...code, name, sourceType: 'codegraph', definition: 'query\u001b[2J\u202e' }, score: 7 }] });
      mocks.templates.mockReturnValue([{ ...template, entry: { ...template.entry, title: name } }]);
      mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: [{ entry: { ...wiki, title: name, body: name }, score: 5 }] });
      const text = await action([...args, '--full']);
      expect(text).toContain('\u001b[1;33mquery\u001b[0m');
      expect(text.replace(/\u001b\[(?:1;33|0)m/g, '')).not.toMatch(/[\u001b\u202e]/);
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
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
  it.each([0, 1, 2, 3])('reminds after sparse knowledge matches (%i), consistently across knowledge routes and formats', async count => {
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: Array.from({ length: count }, (_, i) => ({ entry: { ...wiki, id: `rule-${i}`, title: `Rule ${i}` }, score: 5 - i })) });
    mocks.unified.mockReturnValue({ directMatches: Array.from({ length: count }, (_, i) => ({ node: { id: `knowhow:rule-${i}`, name: `Rule ${i}`, kind: 'knowhow_entry', sourceType: 'knowhow', filePath: `.workflow/knowhow/rule-${i}.md`, status: 'active', category: 'coding', definition: 'Reusable finding' }, score: 5 - i })) });
    for (const args of [[], ['--wiki-only'], ['--kg']]) {
      for (const full of [[], ['--full']]) {
        const output = JSON.parse(await action([...args, ...full, '--json']));
        const text = await action([...args, ...full]);
        if (count < 3) {
          expect(output.knowledgeCaptureHint).toContain(`Only ${count} knowledge match`);
          expect(output.knowledgeCaptureHint).toContain('After completing the related task');
          expect(output.knowledgeCaptureHint).toContain('validated, reusable');
          expect(output.knowledgeCaptureHint).toContain('maestro knowledge stage');
          expect(output.knowledgeCaptureHint).toContain('review before promotion');
          expect(output.knowledgeCaptureHint).toContain('Zero candidates is valid');
          expect(text.match(/  Capture:/g)).toHaveLength(1);
          expect(text).toContain(output.knowledgeCaptureHint);
        } else {
          expect(output).not.toHaveProperty('knowledgeCaptureHint');
          expect(text).not.toContain('  Capture:');
        }
      }
    }
  });
  it.each([1, 2])('does not mistake --limit %i for a knowledge gap', async limit => {
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: Array.from({ length: 4 }, (_, i) => ({ entry: { ...wiki, id: `rule-${i}` }, score: 5 - i })) });
    mocks.unified.mockReturnValue({ directMatches: Array.from({ length: 4 }, (_, i) => ({ node: { id: `knowhow:rule-${i}`, name: `Rule ${i}`, kind: 'knowhow_entry', sourceType: 'knowhow', filePath: `.workflow/knowhow/rule-${i}.md`, status: 'active', category: 'coding' }, score: 5 - i })) });
    for (const args of [[], ['--wiki-only'], ['--kg']]) {
      for (const full of [[], ['--full']]) {
        expect(JSON.parse(await action([...args, ...full, '--limit', String(limit), '--json']))).not.toHaveProperty('knowledgeCaptureHint');
      }
    }
  });
  it('keeps recovery hints alongside capture reminders without counting code or global templates as knowledge', async () => {
    mocks.daemon.mockResolvedValue({ ok: true, filtersApplied: true, results: [] });
    rmSync(join(root, '.workflow', 'kg', 'maestro.db'));
    for (const full of [[], ['--full']]) {
      const output = JSON.parse(await action([...full, '--json']));
      expect(output.hint ?? output.codeIndexHint).toContain('maestro kg init');
      expect(output.knowledgeCaptureHint).toContain('Only 0 knowledge matches');
      const text = await action(full);
      expect(text.indexOf('maestro kg init')).toBeLessThan(text.indexOf('  Capture:'));
    }
  });
  it.each([1, 2])('does not infer a knowledge gap from a KG limit of %i filled by code', async limit => {
    mocks.unified.mockReturnValue({ directMatches: Array.from({ length: 4 }, (_, i) => ({ node: { ...code, id: `code:parse-${i}`, filePath: `src/parser-${i}.ts`, sourceType: 'codegraph' }, score: 5 - i })) });
    for (const full of [[], ['--full']]) {
      const output = JSON.parse(await action(['--kg', ...full, '--limit', String(limit), '--json']));
      expect(output.count).toBe(limit);
      expect(output).not.toHaveProperty('knowledgeCaptureHint');
    }
  });
  it.each([['--code'], ['--kg', '--code'], ['--type', 'template'], ['--exact']])('does not suggest project knowledge capture for source/reference-only searches (%j)', async (...args) => {
    mocks.code.mockReturnValue([]); mocks.unified.mockReturnValue({ directMatches: [] }); mocks.templates.mockReturnValue([]);
    mocks.exact.mockResolvedValue({ results: [], truncated: false, timedOut: false, bytesUsed: 0 });
    for (const full of [[], ['--full']]) {
      expect(JSON.parse(await action([...args, ...full, '--json']))).not.toHaveProperty('knowledgeCaptureHint');
      expect(await action([...args, ...full])).not.toContain('  Capture:');
    }
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
  it.each(['not-initialized', 'empty', 'error'] as const)('shows local %s alongside linked success across compact/full and diagnostics modes', async status => {
    const linked = join(root, 'linked'); mkdirSync(join(linked, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({ workspaces: { linked: [{ name: 'library', path: linked, share: ['codebase'] }] } }));
    mocks.openLinked.mockResolvedValue({ searchCode: () => [code], close() {} });
    if (status === 'not-initialized') rmSync(join(root, '.workflow', 'kg', 'maestro.db'));
    if (status === 'empty') mocks.code.mockReturnValue([]);
    if (status === 'error') mocks.code.mockImplementation(() => { throw new Error('SQLITE driver /secret/private.db'); });
    const hint = status === 'not-initialized' ? 'maestro kg init' : status === 'empty' ? 'maestro kg sync' : 'MAESTRO_DEBUG=1';
    for (const args of [['--code'], []]) {
      for (const mode of [[], ['--full']]) {
        const plain = JSON.parse(await action([...args, ...mode, '--include-linked-code', '--json']));
        const diagnostic = JSON.parse(await action([...args, ...mode, '--include-linked-code', '--json', '--diagnostics']));
        expect(plain.count).toBeGreaterThan(0);
        expect(plain.hint ?? plain.codeIndexHint).toContain(hint);
        expect(diagnostic.results).toEqual(plain.results);
        expect(diagnostic.hint ?? diagnostic.codeIndexHint).toBe(plain.hint ?? plain.codeIndexHint);
        expect(diagnostic.diagnostics.fallbacks).toContainEqual({ source: 'kg', reason: status });
        expect(JSON.stringify(diagnostic)).not.toMatch(/SQLITE|private\.db|secret/);
        expect(await action([...args, ...mode, '--include-linked-code'])).toContain(hint);
        if (mode.length) expect(plain).toMatchObject({ codeIndex: 'ok', localStatus: status });
        else expect(plain).not.toHaveProperty('localStatus');
      }
    }
  });
  it('does not warn for healthy local no-matches alongside linked results', async () => {
    const linked = join(root, 'linked'); mkdirSync(join(linked, '.workflow'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'config.json'), JSON.stringify({ workspaces: { linked: [{ name: 'library', path: linked, share: ['codebase'] }] } }));
    mocks.code.mockReturnValue([]);
    // Empty query result != empty index.
    const local = await import('../graph/kg/engine.js');
    const open = vi.spyOn(local.MaestroGraph, 'open').mockResolvedValue({ searchCode: mocks.code, close() {}, getStats: () => ({ nodesBySourceType: { codegraph: 1 } }) } as never);
    mocks.openLinked.mockResolvedValue({ searchCode: () => [code], close() {} });
    const output = JSON.parse(await action(['--code', '--full', '--include-linked-code', '--json']));
    expect(output).toMatchObject({ count: 1, codeIndex: 'ok', localStatus: 'ok' });
    expect(output).not.toHaveProperty('hint');
    expect(output).not.toHaveProperty('warnings');
    expect(await action(['--code', '--include-linked-code'])).not.toMatch(/Warning|Note|Hint/);
    open.mockRestore();
  });
  it('shows exact timeout/completeness warnings even with no occurrences', async () => {
    mocks.exact.mockResolvedValue({ results: [], truncated: true, timedOut: true, bytesUsed: 0 });
    const text = await action(['--exact']);
    expect(text).toContain('truncated');
    expect(text).toContain('timed out; incomplete');
  });
  it('sanitizes exact human query, path, workspace and preview with intact indentation in both modes', async () => {
    const attack = '\u001b[2J\u001b]8;;https://evil.test\u0007x\u001b]8;;\u001b\\\u009b2K\r\u202e';
    const results = [{ filePath: `src/${attack}.ts`, line: 3, column: 5, preview: `query${attack}snippet`, workspace: `library${attack}` }];
    mocks.exact.mockResolvedValue({ results, truncated: false, timedOut: false, bytesUsed: 100 });
    for (const mode of [[], ['--full']]) {
      const text = await action(['--exact', ...mode], `query${attack}`);
      expect(text).not.toMatch(/[\u001b\u0007\u009b\r\u202e]/);
      expect(text).not.toContain('https://evil.test');
      expect(text.split('\n')[1]).toMatch(/^  \[exact\]  src\//);
      expect(text.split('\n')[2]).toMatch(/^    query/);
      expect(JSON.parse(await action(['--exact', ...mode, '--json'], `query${attack}`))).toMatchObject({ query: `query${attack}`, results });
    }
  });
  it('preserves plain full exact spacing and coordinates', async () => {
    mocks.exact.mockResolvedValue({ results: [{ filePath: 'src/x.ts', line: 3, column: 5, preview: 'query  snippet', workspace: 'linked' }], truncated: false, timedOut: false, bytesUsed: 100 });
    expect(await action(['--exact', '--full'])).toBe('Search: "query" (exact 1 result)\n  [exact]  src/x.ts:3:5  @linked\n    query  snippet');
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
  it('disambiguates repeated aliases with a stable fence or repo id, safely', () => {
    const results = [
      { source: 'wiki', id: 'one', kind: 'spec', name: 'One', alias: 'library', repoId: 'one' },
      { source: 'wiki', id: 'two', kind: 'spec', name: 'Two', alias: 'library', repoId: 'two', workspaceFence: 'repo:two' },
      { source: 'code', id: 'three', kind: 'function', name: 'Three', workspace: 'library', workspaceFence: 'repo:\u001b[2Jthree\u202e' },
    ];
    const text = renderCompactSearch(compactSearchPayload({ query: 'q', count: 3, results })).join('\n');
    expect(text).toContain('[@library; repo:one]');
    expect(text).toContain('[@library; repo:two]');
    expect(text).toContain('[@library; repo:three');
    expect(text).not.toMatch(/[\u001b\u202e]/);
  });
  it('does not expose non-template actions in the compact contract', () => {
    const payload = compactSearchPayload({ query: 'q', count: 1, results: [{ source: 'wiki', id: 'one', kind: 'spec', name: 'One', openCommand: 'unwanted' }] });
    expect(payload.results[0]).not.toHaveProperty('openCommand');
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
