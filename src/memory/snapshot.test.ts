import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { WikiIndexer } from '../../dashboard/src/server/wiki/wiki-indexer.js';
import { MEMORY_PROJECTION_MAX_BYTES, MemoryProjectionError } from '../../shared/memory-projection.js';

// Exercise the edited source parser, not a potentially stale dashboard build.
vi.mock('#maestro-dashboard/wiki/wiki-indexer.js', async () => import('../../dashboard/src/server/wiki/wiki-indexer.js'));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { captureCanonicalMemorySnapshot } from './snapshot.js';

const repoId = '11111111-1111-4111-8111-111111111111';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string;
async function put(path: string, content: string): Promise<string> {
  const abs = join(root, '.workflow', path);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}
function header(page: string): { data: any; body: string } {
  const end = page.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(4);
  return { data: parse(page.slice(4, end)), body: page.slice(end + 5) };
}
async function reject(id: string, code: string): Promise<void> {
  await expect(captureCanonicalMemorySnapshot(root, id)).rejects.toMatchObject({ name: 'MemoryProjectionError', code, message: code });
}
const issue = (id = 'ISS-001', extra: Record<string, unknown> = {}) => ({
  id, title: 'Fix canonical record', description: 'Whole description\n\nKeep details.',
  status: 'open', type: 'bug', priority: 'P1', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
  custom: { provenance: 'review', labels: ['safe'] }, ...extra,
});

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'maestro-memory-snapshot-'));
  await put('repository.json', JSON.stringify({ schema_version: 'repository-identity/1.0', repo_id: repoId, repo_name: 'Synthetic memory lab', created_at: '2026-01-01T00:00:00.000Z' }));
  vi.mocked(fs.open).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(actual.open);
  await fs.rm(root, { recursive: true, force: true });
});

describe('captureCanonicalMemorySnapshot', () => {
  it('captures a physical Knowhow with complete WikiEntry metadata, exact body and deterministic locked YAML', async () => {
    const raw = '---\ntitle: "A title: with YAML # tokens"\ncategory: recipe\nkeywords: [Alpha, Beta]\npriority: high\ncreatedBy: test\nsourceRef: review-1\nrelated: ["[[domain-alpha]]"]\n---\n# Recipe\n\nExact body.  \n';
    const path = await put('knowhow/RCP-safe.md', raw);
    const before = await fs.stat(path);
    const a = await captureCanonicalMemorySnapshot(root, 'knowhow-rcp-safe');
    const b = await captureCanonicalMemorySnapshot(root, 'knowhow-rcp-safe');
    expect(a).toEqual(b);
    expect(a.repoId).toBe(repoId);
    expect(a.sourceFileHash).toBe(sha(raw));
    expect(a.remoteContentHash).toBe(sha(a.pageContent));
    expect(a.recordHash).not.toBe(a.remoteContentHash);
    expect(a.pageRef).toBe(`wiki/maestro/${repoId}/${sha(a.canonicalId)}.md`);
    expect(a.entry.source).toMatchObject({ kind: 'file', path: 'knowhow/RCP-safe.md', repoId, alias: 'current', workspaceFence: `repo:${repoId}` });
    expect(a.entry.ext).toMatchObject({ priority: 'high' });
    const { data, body } = header(a.pageContent);
    expect(data.locked).toBe(true);
    expect(data.title).toBe(a.entry.title);
    expect(data.maestro).toMatchObject({ canonicalId: a.canonicalId, repoId, sourceFileHash: a.sourceFileHash, recordHash: a.recordHash });
    const { body: entryBody, ...metadata } = a.entry;
    expect(data.maestro.record).toEqual(metadata);
    expect(body).toBe(entryBody);
    expect(body).toBe('\n# Recipe\n\nExact body.  \n');
    expect(a.pageContent).not.toContain(root);
    expect(a.pageContent).not.toContain('remoteContentHash');
    expect((await fs.stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(path, 'utf8')).toBe(raw);
    expect(await fs.readdir(join(root, '.workflow'))).toEqual(['knowhow', 'repository.json']);
  });

  it('selects only a Spec child, retaining lifecycle/ref/decision metadata without sibling bodies', async () => {
    await put('specs/rules.md', '---\ntitle: Rules\ncreatedBy: author\n---\n<spec-entry type="rule" title="Chosen" status="deprecated" confidence="contested" ref="knowhow/RCP-one.md" language="en" decisionState="accepted" sid="sid-1" supersedes="sid-0">\n### Chosen\nExact selected content.\n</spec-entry>\n<spec-entry title="Sibling">SECRET SIBLING BODY</spec-entry>');
    const result = await captureCanonicalMemorySnapshot(root, 'spec:project:rules-001');
    expect(result.entry).toMatchObject({ title: 'Chosen', type: 'spec', scope: 'project', status: 'deprecated', parent: 'spec:project:rules', body: '### Chosen\nExact selected content.' });
    expect(result.entry.ext).toMatchObject({ confidence: 'contested', ref: 'knowhow/RCP-one.md', language: 'en', decisionState: 'accepted', sid: 'sid-1', supersedes: 'sid-0' });
    expect(result.pageContent).not.toContain('SECRET SIBLING BODY');
    expect(header(result.pageContent).body).toBe(result.entry.body);
  });

  it('supports the selected project Spec container and legacy heading children', async () => {
    await put('specs/coding-conventions.md', '# Conventions\n\n## [coding] First\nOne\n\n## Second\nTwo\n');
    const container = await captureCanonicalMemorySnapshot(root, 'spec:project:coding-conventions');
    const child = await captureCanonicalMemorySnapshot(root, 'spec:project:coding-conventions-001');
    expect(container.entry.body).toContain('Two');
    expect(child.entry.body).toContain('One');
    expect(child.entry.body).not.toContain('Two');
  });

  it('supports nested selected Knowhow children and physical session-type Knowhow', async () => {
    await put('knowhow/nested/KNW-example.md', '---\ntitle: Session knowledge\n---\n<knowhow-entry title="Chosen" category="learning" sourceRef="session-1">\n### Selected knowledge\nKeep only this.\n</knowhow-entry>\n<knowhow-entry title="Sibling">NO SIBLING</knowhow-entry>');
    const container = await captureCanonicalMemorySnapshot(root, 'knowhow-knw-example');
    expect(container.entry.category).toBe('session');
    const child = await captureCanonicalMemorySnapshot(root, 'knowhow-KNW-example-001');
    expect(child.entry.parent).toBe('knowhow-knw-example');
    expect(child.entry.source.path).toBe('knowhow/nested/KNW-example.md');
    expect(child.pageContent).not.toContain('NO SIBLING');
    expect(header(child.pageContent).body).toBe('### Selected knowledge\nKeep only this.');
  });

  it('captures one Domain term with complete original metadata, not the whole glossary', async () => {
    const term = { id: 'alpha', canonical: 'Alpha', definition: 'A complete definition', aliases: ['A'], keywords: ['key'], relationships: ['beta'], tier: 'core', source: { kind: 'manual', ref: 'decision-1' }, custom: { untouched: true } };
    const raw = JSON.stringify({ version: 1, terms: [term, { id: 'beta', canonical: 'SECRET SIBLING DOMAIN', definition: 'never upload' }] });
    await put('domain/glossary.json', raw);
    const result = await captureCanonicalMemorySnapshot(root, 'domain-alpha');
    expect(result.entry.raw).toEqual(term);
    expect(result.entry.tags).toEqual(['A', 'key']);
    expect(result.sourceFileHash).toBe(sha(raw));
    expect(result.pageContent).not.toContain('SECRET SIBLING DOMAIN');
    expect(header(result.pageContent).data.maestro.record.raw).toEqual(term);
    expect(header(result.pageContent).body).toBe(result.entry.body);
  });

  it('accepts a canonical virtual Issue row with complete raw metadata and description', async () => {
    const row = issue();
    const raw = `${JSON.stringify(issue('ISS-other', { title: 'SECRET SIBLING ISSUE' }))}\n${JSON.stringify(row)}\n`;
    await put('issues/issues.jsonl', raw);
    const result = await captureCanonicalMemorySnapshot(root, 'issue-ISS-001');
    expect(result.entry.raw).toEqual(row);
    expect(result.entry.source).toMatchObject({ kind: 'virtual', path: 'issues/issues.jsonl', line: 2 });
    expect(result.sourceFileHash).toBe(sha(raw));
    expect(result.pageContent).not.toContain('SECRET SIBLING ISSUE');
    expect(header(result.pageContent).body).toBe(row.description);
  });

  it('safely serializes multiline YAML-looking titles without overriding locked', async () => {
    await put('issues/issues.jsonl', JSON.stringify(issue('injection', { title: 'Title\nlocked: false\n---\nmaestro: forged' })));
    const result = await captureCanonicalMemorySnapshot(root, 'issue-injection');
    const { data } = header(result.pageContent);
    expect(data.locked).toBe(true);
    expect(data.title).toBe(result.entry.title);
    expect(data.maestro.repoId).toBe(repoId);
  });

  it.each(['spec:global:rules', 'spec:team:rules', 'spec:personal:user:rules', 'linked:other:knowhow-a', 'kg-thing', 'session-run-one', 'project-one', 'note-one'])('rejects unsupported scope/source %s', async id => {
    await reject(id, 'unsupported-source');
  });
  it.each(['../knowhow-a', 'knowhow-../x', '/tmp/arbitrary.md', 'knowhow-x\n', ''])('rejects noncanonical request %j', async id => {
    await reject(id, 'invalid-request');
  });
  it('does not discover raw transcripts, linked/global specs or run projections', async () => {
    await put('sessions/KNW-hidden.md', '# Not canonical');
    await put('collab/specs/rules.md', '# Not project canonical');
    await reject('knowhow-knw-hidden', 'not-found');
    await reject('spec:project:rules', 'not-found');
  });

  it('rejects a legacy/missing or invalid repository identity without inventing one', async () => {
    await fs.rm(join(root, '.workflow', 'repository.json'));
    await put('knowhow/RCP-safe.md', '# Safe');
    await expect(captureCanonicalMemorySnapshot(root, 'knowhow-rcp-safe')).rejects.toBeInstanceOf(MemoryProjectionError);
    await put('repository.json', '{"repo_id":"not-an-identity"}');
    await reject('knowhow-rcp-safe', 'scope-mismatch');
  });

  it('requires an exact canonical ID instead of tolerant lookup', async () => {
    await put('knowhow/RCP-safe.md', '# Safe');
    await reject('knowhow-RCP-SAFE', 'not-found');
  });

  it('rejects normalized filename collisions rather than choosing a cached winner', async () => {
    await put('knowhow/a/Foo!.md', '# First');
    await put('knowhow/b/foo.md', '# Second');
    await reject('knowhow-foo', 'ambiguous-source');
  });
  it('rejects duplicate Domain IDs', async () => {
    await put('domain/glossary.json', JSON.stringify({ terms: [{ id: 'x', canonical: 'One' }, { id: 'x', canonical: 'Two' }] }));
    await reject('domain-x', 'ambiguous-source');
  });
  it.each([false, true])('rejects duplicate Issue IDs across rows/files, separate=%s', async separate => {
    await put('issues/one.jsonl', JSON.stringify(issue()) + (separate ? '' : `\n${JSON.stringify(issue())}`));
    if (separate) await put('issues/two.jsonl', JSON.stringify(issue('ISS-001', { updated_at: '2027-01-01' })));
    await reject('issue-ISS-001', 'ambiguous-source');
  });

  it('preserves authored /tmp examples, absolute sourceRef and ext metadata unchanged', async () => {
    const body = '\n# Example\n\n```sh\nmkdir -p /tmp/maestro-example\n```\n';
    const sourceRef = 'C:\\Users\\author\\source.md';
    await put('knowhow/RCP-path.md', `---\ntitle: Path\nsourceRef: ${sourceRef}\nfilePath: /tmp/authored-example.md\n---${body}`);
    const result = await captureCanonicalMemorySnapshot(root, 'knowhow-rcp-path');
    expect(result.entry.body).toBe(body);
    expect(result.entry.sourceRef).toBe(sourceRef);
    expect(result.entry.ext.filePath).toBe('/tmp/authored-example.md');
    expect(header(result.pageContent).body).toBe(body);
    expect(header(result.pageContent).data.maestro.record.ext.filePath).toBe('/tmp/authored-example.md');
    expect(result.entry.source.path).toBe('knowhow/RCP-path.md');
    expect(result.pageContent).not.toContain(root);
  });
  it('preserves authored absolute paths in complete raw Issue metadata', async () => {
    const row = issue('path', { custom: { path: '/home/author/example', hostPathExample: root }, description: 'Try /tmp/example for this recipe.' });
    await put('issues/issues.jsonl', JSON.stringify(row));
    const result = await captureCanonicalMemorySnapshot(root, 'issue-path');
    expect(result.entry.raw).toEqual(row);
    expect(header(result.pageContent).data.maestro.record.raw).toEqual(row);
    expect(header(result.pageContent).body).toBe(row.description);
    expect(result.entry.source.path).toBe('issues/issues.jsonl');
  });
  it('rejects an absolute path introduced in generated source provenance', async () => {
    await put('knowhow/RCP-path.md', '# Authored body');
    const original = WikiIndexer.prototype.parseCapturedCanonicalSource;
    vi.spyOn(WikiIndexer.prototype, 'parseCapturedCanonicalSource').mockImplementation(async function (rel, capture) {
      const entries = await original.call(this, rel, capture);
      entries[0].source.path = join(root, '.workflow', rel);
      return entries;
    });
    await reject('knowhow-rcp-path', 'unsupported-source');
  });

  it('bounds source bytes before reading a too-large regular source', async () => {
    const path = await put('knowhow/RCP-large.md', 'x'.repeat(4 * 1024 * 1024 + 1));
    await reject('knowhow-rcp-large', 'source-too-large');
    expect(vi.mocked(fs.open).mock.calls.filter(([file]) => String(file) === path)).toHaveLength(0);
  });
  it('enforces the final UTF-8 byte limit, not JS character count', async () => {
    await put('knowhow/RCP-large.md', '---\ntitle: Large\nsummary: Small\n---\n' + '界'.repeat(90_000));
    await reject('knowhow-rcp-large', 'source-too-large');
  });
  it('accepts exactly the final byte bound and rejects one byte more', async () => {
    const prefix = '---\ntitle: Bound\nsummary: Small\n---\n';
    const path = await put('knowhow/RCP-bound.md', prefix + 'a');
    const first = await captureCanonicalMemorySnapshot(root, 'knowhow-rcp-bound');
    const bodyBytes = MEMORY_PROJECTION_MAX_BYTES - Buffer.byteLength(first.pageContent) + 1;
    await fs.writeFile(path, prefix + 'a'.repeat(bodyBytes));
    const exact = await captureCanonicalMemorySnapshot(root, 'knowhow-rcp-bound');
    expect(Buffer.byteLength(exact.pageContent)).toBe(MEMORY_PROJECTION_MAX_BYTES);
    await fs.appendFile(path, 'a');
    await reject('knowhow-rcp-bound', 'source-too-large');
  });

  it('opens each candidate only once with nofollow/nonblocking flags and parses those captured bytes', async () => {
    const path = await put('knowhow/RCP-once.md', '# The captured body');
    const spy = vi.spyOn(WikiIndexer.prototype, 'parseCapturedCanonicalSource');
    const result = await captureCanonicalMemorySnapshot(root, 'knowhow-rcp-once');
    const calls = vi.mocked(fs.open).mock.calls.filter(([file]) => String(file) === path);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    expect(spy).toHaveBeenCalledWith('knowhow/RCP-once.md', expect.objectContaining({ content: '# The captured body' }));
    expect(result.entry.body).toBe('# The captured body');
  });

  it('supports parser-generated child IDs containing filename spaces', async () => {
    await put('knowhow/RCP with spaces.md', '<knowhow-entry title="Selected">Exact body</knowhow-entry>');
    const result = await captureCanonicalMemorySnapshot(root, 'knowhow-RCP with spaces-001');
    expect(result.entry.body).toBe('Exact body');
  });

  it('rejects a Spec child/container collision across filenames', async () => {
    await put('specs/rules.md', '<spec-entry title="Selected">One</spec-entry>');
    await put('specs/rules-001.md', '# Same canonical ID');
    await reject('spec:project:rules-001', 'ambiguous-source');
  });

  it('rejects same-file replacement between lstat and open', async () => {
    const path = await put('knowhow/RCP-open.md', '# First');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === path) {
        const replacement = await put('knowhow/replacement.tmp', '# Other');
        await fs.rename(replacement, path);
      }
      return actual.open(...args);
    });
    await reject('knowhow-rcp-open', 'source-changed');
  });

  it('bounds directory recursion before opening a deeply nested source', async () => {
    const dirs = Array.from({ length: 17 }, () => 'deep').join('/');
    await put(`knowhow/${dirs}/RCP-deep.md`, '# Deep');
    await reject('knowhow-rcp-deep', 'source-too-large');
  });

  it('rejects same-sized in-place changes during parsing', async () => {
    const path = await put('knowhow/RCP-race.md', '# First');
    const original = WikiIndexer.prototype.parseCapturedCanonicalSource;
    vi.spyOn(WikiIndexer.prototype, 'parseCapturedCanonicalSource').mockImplementation(async function (rel, capture) {
      const entries = await original.call(this, rel, capture);
      expect(entries[0].body).toBe('# First');
      await fs.writeFile(path, '# Other');
      return entries;
    });
    await reject('knowhow-rcp-race', 'source-changed');
  });
  it('rejects same-sized inode replacement with preserved mtime', async () => {
    const path = await put('knowhow/RCP-race.md', '# First');
    const stats = await fs.stat(path);
    const original = WikiIndexer.prototype.parseCapturedCanonicalSource;
    vi.spyOn(WikiIndexer.prototype, 'parseCapturedCanonicalSource').mockImplementation(async function (rel, capture) {
      const entries = await original.call(this, rel, capture);
      await put('knowhow/replacement.tmp', '# Other');
      await fs.utimes(join(root, '.workflow/knowhow/replacement.tmp'), stats.atime, stats.mtime);
      await fs.rename(join(root, '.workflow/knowhow/replacement.tmp'), path);
      return entries;
    });
    await reject('knowhow-rcp-race', 'source-changed');
  });
  it('rejects newly introduced colliding sources during selection', async () => {
    await put('knowhow/foo.md', '# First');
    const original = WikiIndexer.prototype.parseCapturedCanonicalSource;
    vi.spyOn(WikiIndexer.prototype, 'parseCapturedCanonicalSource').mockImplementation(async function (rel, capture) {
      const entries = await original.call(this, rel, capture);
      await put('knowhow/Foo!.md', '# Collision');
      return entries;
    });
    await reject('knowhow-foo', 'source-changed');
  });

  it('never lets captured-content parsing fall back to newer disk bytes (Spec/Knowhow/Domain/Issue)', async () => {
    const indexer = new WikiIndexer({ workflowRoot: join(root, '.workflow'), role: 'hermetic', repository: { repoId, repoName: 'Synthetic memory lab' } });
    const fixtures = [
      { path: 'specs/one.md', captured: '# Captured spec', disk: '# New spec', id: 'spec:project:one' },
      { path: 'knowhow/one.md', captured: '# Captured knowhow', disk: '# New knowhow', id: 'knowhow-one' },
      { path: 'domain/glossary.json', captured: JSON.stringify({ terms: [{ id: 'one', canonical: 'Captured domain' }] }), disk: '{"terms":[]}', id: 'domain-one' },
      { path: 'issues/one.jsonl', captured: JSON.stringify(issue('one')), disk: '', id: 'issue-one' },
    ];
    for (const fixture of fixtures) {
      await put(fixture.path, fixture.disk);
      const entries = await indexer.parseCapturedCanonicalSource(fixture.path, { content: fixture.captured, stats: { birthtimeMs: 1000, mtimeMs: 2000 } });
      const entry = entries.find(e => e.id === fixture.id);
      expect(entry, fixture.path).toBeDefined();
      expect(entry!.updated).toBe(fixture.path.startsWith('issues/') ? issue().updated_at : new Date(2000).toISOString());
      expect(entry!.body).not.toContain('New');
    }
    expect(await indexer.parseCapturedCanonicalSource('sessions/transcript.md', { content: 'No', stats: { birthtimeMs: 1, mtimeMs: 2 } })).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects source/parent symlinks and FIFOs without blocking (POSIX)', async () => {
    const path = await put('knowhow/RCP-real.md', '# Real');
    await fs.symlink(path, join(root, '.workflow/knowhow/RCP-link.md'));
    await reject('knowhow-rcp-link', 'unsupported-source');
    await fs.rm(join(root, '.workflow/knowhow/RCP-link.md'));
    execFileSync('mkfifo', [join(root, '.workflow/knowhow/RCP-pipe.md')]);
    await reject('knowhow-rcp-pipe', 'unsupported-source');
    await fs.rm(join(root, '.workflow/knowhow/RCP-pipe.md'));
    await fs.mkdir(join(root, 'outside'));
    await fs.symlink(join(root, 'outside'), join(root, '.workflow/knowhow/nested'));
    await reject('knowhow-rcp-real', 'unsupported-source');
  });

  it('rejects Windows directory junction sources', async () => {
    if (process.platform !== 'win32') return;
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'RCP-escape.md'), '# Outside workflow');
    await fs.mkdir(join(root, '.workflow', 'knowhow'));
    await fs.symlink(outside, join(root, '.workflow/knowhow/nested'), 'junction');
    await reject('knowhow-rcp-escape', 'unsupported-source');
  });
});
