import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { stringify } from 'yaml';
import { WikiIndexer } from '#maestro-dashboard/wiki/wiki-indexer.js';
import type { WikiEntry } from '../../dashboard/src/server/wiki/wiki-types.js';
import {
  MEMORY_PROJECTION_MAX_BYTES, MEMORY_PROJECTION_SCHEMA, MemoryProjectionError,
  type CanonicalMemorySnapshot,
} from '../../shared/memory-projection.js';
import { resolveMemoryRepository } from './scope.js';

// The final page has its own smaller limit. A selected row/block may live in a
// larger container; neither discovery nor a growing file gets an unbounded read.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 8192;
const MAX_DEPTH = 16;
type Family = 'spec' | 'knowhow' | 'domain' | 'issue';
interface Capture { bytes: Buffer; stats: BigIntStats }

function fail(code: ConstructorParameters<typeof MemoryProjectionError>[0]): never {
  throw new MemoryProjectionError(code);
}
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function safeParents(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) fail('unsupported-source');
  let dir = dirname(path);
  for (;;) {
    const stats = await lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('unsupported-source');
    if (dir === root) break;
    dir = dirname(dir);
  }
}
async function captureFile(root: string, path: string, maxBytes = MAX_SOURCE_BYTES): Promise<Capture> {
  await safeParents(root, path);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('unsupported-source');
  if (before.size > BigInt(maxBytes)) fail('source-too-large');
  // NONBLOCK prevents FIFO substitution from hanging; NOFOLLOW fences final
  // symlink substitution on platforms which implement it. Never retry without it.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) fail('source-changed');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    await safeParents(root, path);
    if (!sameFile(opened, after) || !sameFile(after, named) || length !== Number(opened.size)) fail('source-changed');
    return { bytes: buffer.subarray(0, length), stats: after };
  } finally {
    await handle.close();
  }
}
function familyForId(id: string): Family {
  if (typeof id !== 'string' || !id || id.length > 1024 || /[/\\\u0000-\u001f\u007f]/.test(id)) fail('invalid-request');
  if (/^spec:project:[^:]+$/.test(id)) return 'spec';
  for (const family of ['knowhow', 'domain', 'issue'] as const) {
    if (id.startsWith(`${family}-`) && id.length > family.length + 1 && !id.includes(':')) return family;
  }
  return fail('unsupported-source');
}
function candidateName(path: string, family: Family, id: string): boolean {
  if (family === 'domain' || family === 'issue') return true;
  const stem = basename(path, extname(path));
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const prefix = family === 'spec' ? 'spec:project:' : 'knowhow-';
  // This is only a discovery filter. Actual IDs and selected bodies always come
  // from WikiIndexer, including its exact case-sensitive child-ID semantics.
  return id === `${prefix}${slug}`
    || (id.startsWith(`${prefix}${stem}-`) && /^\d{3,}$/.test(id.slice(prefix.length + stem.length + 1)));
}
async function discover(root: string, family: Family, id: string): Promise<string[]> {
  if (family === 'domain') return [join(root, 'domain', 'glossary.json')];
  const base = join(root, family === 'spec' ? 'specs' : family === 'knowhow' ? 'knowhow' : 'issues');
  const paths: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) fail('source-too-large');
    let stats;
    try { stats = await lstat(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('unsupported-source');
    const directory = await opendir(dir);
    for await (const item of directory) {
      if (++visited > MAX_DISCOVERY_ENTRIES) fail('source-too-large');
      const path = join(dir, item.name);
      if (family === 'knowhow' && item.isDirectory()) await walk(path, depth + 1);
      else if (family === 'knowhow' && item.isSymbolicLink()) fail('unsupported-source');
      else if (extname(item.name).toLowerCase() === (family === 'issue' ? '.jsonl' : '.md')
        && candidateName(path, family, id)) paths.push(path);
    }
  }
  await walk(base, 0);
  return paths.sort();
}
/** Stable JSON-compatible metadata, preserving all defined WikiEntry fields. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => [key, stable(v)]),
  );
  return value;
}
function assertSourceProvenance(entry: WikiEntry, projectRoot: string): void {
  const path = entry.source.path;
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\')
    || path.split('/').some(part => part === '..' || part === '.' || part === '')) fail('unsupported-source');
  // These fields are supplied by repository context/the parser, not authored
  // record content. Never recursively inspect body/raw/ext/sourceRef: absolute
  // paths there can be intentional examples or canonical metadata to preserve.
  const provenance = [path, entry.repoName, entry.source.repoName, entry.repoId,
    entry.source.repoId, entry.alias, entry.source.alias, entry.workspaceFence, entry.source.workspaceFence];
  for (const value of provenance) {
    if (value && (isAbsolute(value) || win32.isAbsolute(value)
      || value.toLowerCase().includes(projectRoot.toLowerCase()))) fail('unsupported-source');
  }
}

/** Capture exactly one existing current-repository canonical knowledge record. No writes or network. */
export async function captureCanonicalMemorySnapshot(projectRoot: string, canonicalId: string): Promise<CanonicalMemorySnapshot> {
  const family = familyForId(canonicalId);
  let indexer: WikiIndexer | undefined;
  try {
    // Bound/preflight the identity before the existing context resolver reads it.
    const suppliedRoot = resolve(projectRoot);
    await captureFile(suppliedRoot, join(suppliedRoot, '.workflow', 'repository.json'), 16 * 1024);
    const context = resolveMemoryRepository(suppliedRoot);
    if (!context.repoId || !context.identityPersisted || context.relation !== 'current') fail('scope-mismatch');
    const root = context.workflowRoot;
    indexer = new WikiIndexer({
      workflowRoot: root, role: 'hermetic', includeCliSessions: false,
      repository: { repoId: context.repoId, repoName: context.repoName, alias: 'current', workspaceFence: `repo:${context.repoId}` },
    });
    const paths = await discover(root, family, canonicalId);
    const captures = new Map<string, Capture>();
    let selected: { entry: WikiEntry; capture: Capture } | undefined;
    let total = 0;
    for (const path of paths) {
      const capture = await captureFile(root, path);
      total += capture.bytes.length;
      if (total > MAX_CAPTURE_BYTES) fail('source-too-large');
      captures.set(path, capture);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(capture.bytes);
      const entries = await indexer.parseCapturedCanonicalSource(relative(root, path).replace(/\\/g, '/'), {
        content,
        stats: { birthtimeMs: Number(capture.stats.birthtimeMs), mtimeMs: Number(capture.stats.mtimeMs) },
      });
      for (const entry of entries) {
        if (entry.id !== canonicalId) continue;
        if (selected) fail('ambiguous-source');
        if (entry.type !== family || (family === 'spec' && entry.scope !== 'project')
          || entry.source.workspace || entry.alias !== 'current' || entry.repoId !== context.repoId) fail('scope-mismatch');
        selected = { entry, capture };
      }
    }
    // Fence replacements/edits and newly introduced colliding sources while
    // selecting. This is a snapshot, not a lock held across remote operations.
    for (const [path, capture] of captures) {
      await safeParents(root, path);
      if (!sameFile(capture.stats, await lstat(path, { bigint: true }))) fail('source-changed');
    }
    if (JSON.stringify(paths) !== JSON.stringify(await discover(root, family, canonicalId))) fail('source-changed');
    const current = resolveMemoryRepository(context.projectRoot);
    if (current.repoId !== context.repoId || current.workflowRoot !== root || current.repoName !== context.repoName) fail('scope-mismatch');
    if (!selected) fail('not-found');
    const entry = stable(selected.entry) as WikiEntry;
    assertSourceProvenance(entry, context.projectRoot);
    const sourceFileHash = hash(selected.capture.bytes);
    const recordHash = hash(JSON.stringify(entry));
    const pageRef = `wiki/maestro/${context.repoId}/${hash(canonicalId)}.md`;
    const { body, ...metadata } = entry;
    const header = stringify({ title: entry.title, locked: true, maestro: {
      schemaVersion: MEMORY_PROJECTION_SCHEMA, canonicalId, repoId: context.repoId,
      sourceFileHash, recordHash, record: metadata,
    } }, { aliasDuplicateObjects: false, lineWidth: 0 });
    const pageContent = `---\n${header}---\n${body}`;
    if (Buffer.byteLength(pageContent, 'utf8') > MEMORY_PROJECTION_MAX_BYTES) fail('source-too-large');
    return { entry, canonicalId, repoId: context.repoId, sourceFileHash, recordHash, pageRef, pageContent, remoteContentHash: hash(pageContent) };
  } catch (error) {
    if (error instanceof MemoryProjectionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail('not-found');
    if (code === 'ELOOP') fail('unsupported-source');
    return fail('unsupported-source');
  } finally {
    await indexer?.close();
  }
}
