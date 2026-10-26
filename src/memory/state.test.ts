import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { assertMemoryManifestCapacity, findMemoryReceipt, loadMemoryManifest, memoryHash, persistMemoryManifest, withMemoryAssetLock, loadMemoryAssetLedger, persistMemoryAssetLedger, type MemoryManifest } from './state.js';
import type { MemoryProjectionReceipt } from '../../shared/memory-projection.js';
const roots: string[] = [];
const assetKey = memoryHash('asset');
const hostRoot = (workflow: string) => join(dirname(workflow), 'host-assets');
const repoId = '11111111-1111-4111-8111-111111111111';
const canonicalId = 'spec:project:one';
const receipt = (): MemoryProjectionReceipt => ({ operationId: 'one', intentHash: memoryHash('intent'), providerId: 'wiki', namespace: 'tencent:namespace', assetKey, repoId, canonicalId,
  pageRef: `wiki/maestro/${repoId}/${memoryHash(canonicalId)}.md`, title: 'One', action: 'save', state: 'pending', searchability: 'unverified',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', recordHash: memoryHash('record'), sourceFileHash: memoryHash('source'), desiredRemoteHash: memoryHash('remote') });
const manifest = (): MemoryManifest => ({ version: 1, assetKey, receipts: [receipt()] });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'maestro-memory-state-')); roots.push(root); const workflow = join(root, '.workflow'); await mkdir(workflow); return workflow; }
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
describe('durable bounded projection state', () => {
  it('atomically roundtrips without payload content and removes only its own lock', async () => {
    const workflow = await fixture();
    await withMemoryAssetLock(workflow, assetKey, () => persistMemoryManifest(workflow, manifest()), hostRoot(workflow));
    expect(await loadMemoryManifest(workflow, assetKey)).toEqual(manifest());
    expect(await findMemoryReceipt(workflow, repoId, 'wiki', canonicalId, hostRoot(workflow))).toEqual(receipt());
    expect(await readdir(join(workflow, 'memory-projections'))).toEqual([memoryHash(assetKey)+'.json']);
    expect(await readFile(join(workflow, 'memory-projections', memoryHash(assetKey)+'.json'), 'utf8')).not.toContain('pageContent');
  });
  it('coordinates the same asset across different physical repository state roots', async () => {
    const first = await fixture(); const second = await fixture();
    await withMemoryAssetLock(first, assetKey, async () => {
      await expect(withMemoryAssetLock(second, assetKey, async () => 'must not execute', hostRoot(first))).rejects.toMatchObject({ code: 'asset-locked' });
    }, hostRoot(first));
    await expect(withMemoryAssetLock(second, assetKey, async () => 'released', hostRoot(first))).resolves.toBe('released');
  });
  it('never expires or steals an existing lock', async () => {
    const workflow = await fixture(); const dir = join(workflow, 'memory-projections'); await mkdir(dir);
    const lock = join(dir, memoryHash(assetKey)+'.lock'); await mkdir(lock);
    await expect(withMemoryAssetLock(workflow, assetKey, async () => 'must not execute', hostRoot(workflow))).rejects.toMatchObject({ code: 'asset-locked' });
    expect(await readdir(dir)).toEqual([memoryHash(assetKey)+'.lock']);
  });
  it.each(['broken', '{}', JSON.stringify({ ...manifest(), assetKey: memoryHash('different') })])('rejects corrupt/mismatched persisted state (%s)', async raw => {
    const workflow = await fixture(); const dir = join(workflow, 'memory-projections'); await mkdir(dir);
    await writeFile(join(dir, memoryHash(assetKey)+'.json'), raw);
    await expect(loadMemoryManifest(workflow, assetKey)).rejects.toMatchObject({ code: 'state-invalid' });
    await expect(persistMemoryManifest(workflow, manifest())).rejects.toMatchObject({ code: 'state-invalid' });
  });
  it('rejects oversized existing state before allocation/parsing', async () => {
    const workflow = await fixture(); const dir = join(workflow, 'memory-projections'); await mkdir(dir);
    await writeFile(join(dir, memoryHash(assetKey)+'.json'), Buffer.alloc(1_048_577));
    await expect(loadMemoryManifest(workflow, assetKey)).rejects.toMatchObject({ code: 'state-invalid' });
  });
  it('fails closed on symbolic state files', async () => {
    const workflow = await fixture(); const dir = join(workflow, 'memory-projections'); await mkdir(dir);
    const outside = join(workflow, 'outside.json'); await writeFile(outside, JSON.stringify(manifest()));
    // Windows file symlinks may require elevation; directory junction safety is covered in runtime.test.ts.
    if (process.platform === 'win32') return;
    await symlink(outside, join(dir, memoryHash(assetKey)+'.json'));
    await expect(loadMemoryManifest(workflow, assetKey)).rejects.toMatchObject({ code: 'state-invalid' });
  });
  it('bounds history, effects and reserves state capacity before send', () => {
    const full = manifest(); full.receipts = Array.from({ length: 257 }, (_, i) => ({ ...receipt(), operationId: `op-${i}` }));
    expect(() => assertMemoryManifestCapacity(full)).toThrow('state-invalid');
    const large = manifest(); large.receipts[0].effects = { deletedPages: [], rewrittenFiles: [], rewrittenFileCount: -1 };
    expect(() => assertMemoryManifestCapacity(large)).toThrow('state-invalid');
    expect(() => assertMemoryManifestCapacity(manifest(), 1_048_576)).toThrow('state-full');
  });
  it('durably roundtrips asset ambiguity without paths or content and fails closed on corruption', async () => {
    const workflow = await fixture();
    const ledger = { version: 1 as const, assetKey, cascadeEpoch: 1,
      pending: { owner: memoryHash(workflow), operationId: 'uncertain', intentHash: memoryHash('intent'), action: 'remove' as const, epochBefore: 0 } };
    await persistMemoryAssetLedger(ledger, hostRoot(workflow));
    expect(await loadMemoryAssetLedger(assetKey, hostRoot(workflow))).toEqual(ledger);
    const path = join(hostRoot(workflow), memoryHash(assetKey)+'.json');
    expect(await readFile(path, 'utf8')).not.toContain(workflow);
    await writeFile(path, 'corrupt');
    await expect(loadMemoryAssetLedger(assetKey, hostRoot(workflow))).rejects.toMatchObject({ code: 'state-invalid' });
    await expect(persistMemoryAssetLedger(ledger, hostRoot(workflow))).rejects.toMatchObject({ code: 'state-invalid' });
  });
  it('refuses duplicate IDs and arbitrary provenance/fields', () => {
    const duplicate = manifest(); duplicate.receipts.push(receipt()); expect(() => assertMemoryManifestCapacity(duplicate)).toThrow('state-invalid');
    for (const patch of [{ pageRef: 'wiki/other.md' }, { body: 'payload' }, { state: 'maybe' }, { intentHash: 'bad' }]) {
      const invalid = manifest(); Object.assign(invalid.receipts[0], patch); expect(() => assertMemoryManifestCapacity(invalid)).toThrow('state-invalid');
    }
  });
});
