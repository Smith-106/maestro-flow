import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { MEMORY_REMOVE_MAX_BYTES, MEMORY_REMOVE_MAX_PATHS, MemoryProjectionError, type MemoryProjectionReceipt } from '../../shared/memory-projection.js';

export const MAX_MEMORY_RECEIPTS = 256;
const MAX_STATE_BYTES = 1_048_576;
export interface MemoryManifest { version: 1; assetKey: string; cascadeEpoch?: number; receipts: MemoryProjectionReceipt[] }
export interface MemoryAssetLedger {
  version: 1;
  assetKey: string;
  cascadeEpoch: number;
  generation?: string;
  pending?: { owner: string; operationId: string; intentHash: string; action: 'save' | 'update' | 'remove'; epochBefore: number };
}
export const memoryHash = (value: string): string => createHash('sha256').update(value).digest('hex');
function invalid(): never { throw new MemoryProjectionError('state-invalid'); }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function directory(path: string, create: boolean): Promise<boolean> {
  try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid(); return true; }
  catch (error) {
    if (!missing(error)) throw error;
    if (!create) return false;
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    return true;
  }
}
async function root(workflowRoot: string, create: boolean): Promise<string | null> {
  if (!await directory(workflowRoot, false)) invalid();
  const path = join(workflowRoot, 'memory-projections');
  return await directory(path, create) ? path : null;
}
export function memoryAssetLockDirectory(): string { return join(homedir(), '.maestro', 'memory-projection-assets'); }
async function assetRoot(override: string | undefined, create: boolean): Promise<string | null> {
  const path = override ?? memoryAssetLockDirectory();
  if (!override && !await directory(dirname(path), create)) return null;
  if (!await directory(path, create)) return null;
  if (process.getuid) {
    const stat = await lstat(path);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) invalid();
  }
  return path;
}
function validate(value: unknown, assetKey?: string): MemoryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const data = value as MemoryManifest;
  if (Object.keys(data).some(key => !['version', 'assetKey', 'cascadeEpoch', 'receipts'].includes(key)) || data.version !== 1 ||
      typeof data.assetKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.assetKey) || (assetKey && data.assetKey !== assetKey) ||
      (data.cascadeEpoch !== undefined && (!Number.isSafeInteger(data.cascadeEpoch) || data.cascadeEpoch < 0)) ||
      !Array.isArray(data.receipts) || data.receipts.length > MAX_MEMORY_RECEIPTS) invalid();
  const fields = ['operationId','intentHash','coordinationId','action','providerId','namespace','assetKey','repoId','canonicalId','pageRef','title',
    'recordHash','sourceFileHash','expectedRemoteHash','desiredRemoteHash','state','searchability','createdAt','updatedAt','effects'];
  const ids = new Set<string>();
  for (const r of data.receipts) {
    if (!r || typeof r !== 'object' || Object.keys(r).some(key => !fields.includes(key))) invalid();
    for (const key of ['operationId','intentHash','providerId','namespace','assetKey','repoId','canonicalId','pageRef','title','createdAt','updatedAt'] as const) {
      if (typeof r[key] !== 'string' || r[key].length > 2048 || /[\u0000-\u001f\u007f]/.test(r[key])) invalid();
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.operationId) || ids.has(r.operationId) || r.assetKey !== data.assetKey) invalid();
    ids.add(r.operationId);
    for (const key of ['intentHash','coordinationId','recordHash','sourceFileHash','expectedRemoteHash','desiredRemoteHash'] as const) {
      if ((key === 'intentHash' || r[key] !== undefined) && !/^[a-f0-9]{64}$/.test(r[key] ?? '')) invalid();
    }
    if (!['save','update','remove'].includes(r.action) || !['pending','stored','removed','indeterminate','invalidated','not-sent'].includes(r.state) ||
        !['verified','unverified','not-applicable'].includes(r.searchability) || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.updatedAt))) invalid();
    if (!r.repoId || !r.canonicalId || r.pageRef !== `wiki/maestro/${r.repoId}/${memoryHash(r.canonicalId)}.md`) invalid();
    if (r.action !== 'remove' && (!r.desiredRemoteHash || !r.recordHash || !r.sourceFileHash)) invalid();
    if (r.effects !== undefined) {
      if (!r.effects || Object.keys(r.effects).some(key => !['deletedPages','rewrittenFiles','rewrittenFileCount'].includes(key))) invalid();
      if (r.effects.rewrittenFileCount !== undefined && (!Number.isSafeInteger(r.effects.rewrittenFileCount) || r.effects.rewrittenFileCount < 0)) invalid();
      if (Buffer.byteLength(JSON.stringify(r.effects)) > MEMORY_REMOVE_MAX_BYTES) invalid();
      for (const values of [r.effects.deletedPages, r.effects.rewrittenFiles]) {
        if (!Array.isArray(values) || values.length > MEMORY_REMOVE_MAX_PATHS || values.some(v => typeof v !== 'string' || v.length > 2048 || /[\u0000-\u001f\u007f]/.test(v))) invalid();
      }
    }
  }
  return data;
}
async function readJson(path: string, maxBytes: number): Promise<unknown | undefined> {
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) invalid();
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.dev !== before.dev || stat.ino !== before.ino) invalid();
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    const after = await file.stat();
    const named = await lstat(path);
    if (size > maxBytes || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || named.ino !== stat.ino || named.dev !== stat.dev || !named.isFile() || named.isSymbolicLink()) invalid();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } catch (error) { if (missing(error)) return undefined; if (error instanceof MemoryProjectionError) throw error; return invalid(); }
  finally { await file?.close(); }
}
async function readManifest(path: string, assetKey?: string): Promise<MemoryManifest | null> {
  const data = await readJson(path, MAX_STATE_BYTES);
  return data === undefined ? null : validate(data, assetKey);
}
export async function loadMemoryManifest(workflowRoot: string, assetKey: string): Promise<MemoryManifest> {
  const dir = await root(workflowRoot, false);
  return (dir ? await readManifest(join(dir, `${memoryHash(assetKey)}.json`), assetKey) : null) ?? { version: 1, assetKey, receipts: [] };
}
function validateLedger(value: unknown, assetKey: string): MemoryAssetLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const data = value as MemoryAssetLedger;
  if (Object.keys(data).some(k => !['version','assetKey','cascadeEpoch','generation','pending'].includes(k)) || data.version !== 1 || data.assetKey !== assetKey ||
      !/^[a-f0-9]{64}$/.test(data.assetKey) || !Number.isSafeInteger(data.cascadeEpoch) || data.cascadeEpoch < 0 ||
      (data.generation !== undefined && !/^[a-f0-9]{64}$/.test(data.generation))) invalid();
  const p = data.pending;
  if (p !== undefined && (!p || typeof p !== 'object' || Object.keys(p).some(k => !['owner','operationId','intentHash','action','epochBefore'].includes(k)) ||
      !/^[a-f0-9]{64}$/.test(p.owner) || !/^[a-f0-9]{64}$/.test(p.intentHash) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p.operationId) ||
      !['save','update','remove'].includes(p.action) || !Number.isSafeInteger(p.epochBefore) || p.epochBefore < 0 || p.epochBefore > data.cascadeEpoch)) invalid();
  return data;
}
export async function loadMemoryAssetLedger(assetKey: string, hostRoot?: string): Promise<MemoryAssetLedger> {
  const dir = await assetRoot(hostRoot, false);
  const data = dir ? await readJson(join(dir, `${memoryHash(assetKey)}.json`), 16_384) : undefined;
  return data === undefined ? { version: 1, assetKey, cascadeEpoch: 0 } : validateLedger(data, assetKey);
}
export function refreshMemoryCascade(manifest: MemoryManifest, epoch: number): boolean {
  if ((manifest.cascadeEpoch ?? 0) >= epoch) return false;
  for (const receipt of manifest.receipts) if (receipt.state === 'stored') {
    receipt.state = 'invalidated'; receipt.searchability = 'unverified'; receipt.updatedAt = new Date().toISOString();
  }
  manifest.cascadeEpoch = epoch;
  return true;
}
export async function findMemoryReceipt(workflowRoot: string, repoId: string, providerId: string, canonicalId: string, hostRoot?: string): Promise<MemoryProjectionReceipt | undefined> {
  const dir = await root(workflowRoot, false);
  if (!dir) return undefined;
  const names = await readdir(dir);
  if (names.length > 512) throw new MemoryProjectionError('state-full');
  const matches: MemoryProjectionReceipt[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const data = await readManifest(join(dir, name));
    if (!data || name !== `${memoryHash(data.assetKey)}.json`) invalid();
    refreshMemoryCascade(data, (await loadMemoryAssetLedger(data.assetKey, hostRoot)).cascadeEpoch);
    matches.push(...data.receipts.filter(r => r.repoId === repoId && r.providerId === providerId && r.canonicalId === canonicalId));
  }
  return matches.sort((a,b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
}
async function withDirectoryLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  // Never steal automatically, even by age: a live process may be waiting on HTTP.
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MemoryProjectionError('asset-locked'); throw new MemoryProjectionError('state-invalid'); }
  const inode = await lstat(path);
  try { return await run(); }
  finally {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== inode.dev || current.ino !== inode.ino) invalid();
    await rmdir(path);
  }
}
export async function withMemoryAssetLock<T>(workflowRoot: string, assetKey: string, run: () => Promise<T>, hostRoot?: string): Promise<T> {
  const dir = (await root(workflowRoot, true))!;
  const shared = (await assetRoot(hostRoot, true))!;
  return withDirectoryLock(join(shared, `${memoryHash(assetKey)}.lock`), () => withDirectoryLock(join(dir, `${memoryHash(assetKey)}.lock`), run));
}
export function assertMemoryManifestCapacity(manifest: MemoryManifest, reserveBytes = 0): void {
  validate(manifest, manifest.assetKey);
  if (Buffer.byteLength(JSON.stringify(manifest)) + reserveBytes > MAX_STATE_BYTES) throw new MemoryProjectionError('state-full');
}
async function persistJson(dir: string, target: string, value: unknown): Promise<void> {
  const temp = join(dir, `.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close(); file = undefined;
    await rename(temp, target);
    if (process.platform !== 'win32') { const directory = await open(dir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
  } catch { throw new MemoryProjectionError('state-invalid'); }
  finally { await file?.close(); await unlink(temp).catch(() => undefined); }
}
export async function persistMemoryManifest(workflowRoot: string, manifest: MemoryManifest): Promise<void> {
  assertMemoryManifestCapacity(manifest);
  const dir = (await root(workflowRoot, true))!;
  const target = join(dir, `${memoryHash(manifest.assetKey)}.json`);
  await readManifest(target, manifest.assetKey);
  await persistJson(dir, target, manifest);
}
export async function persistMemoryAssetLedger(ledger: MemoryAssetLedger, hostRoot?: string): Promise<void> {
  validateLedger(ledger, ledger.assetKey);
  const dir = (await assetRoot(hostRoot, true))!;
  await loadMemoryAssetLedger(ledger.assetKey, hostRoot);
  await persistJson(dir, join(dir, `${memoryHash(ledger.assetKey)}.json`), ledger);
}
