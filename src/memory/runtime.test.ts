import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMemoryProjection, validateMemoryProjectionRequest, type MemoryRuntimeDependencies } from './runtime.js';
import { memoryHash, withMemoryAssetLock, loadMemoryManifest, persistMemoryManifest, loadMemoryAssetLedger, persistMemoryAssetLedger } from './state.js';
import type { CanonicalMemorySnapshot, MemoryProjectionAdapter, MemoryProjectionRequest } from '../../shared/memory-projection.js';
import type { TencentProviderConfig } from '../search/providers/config.js';
import { createTencentMemoryAdapter } from './tencent.js';
const roots: string[] = [];
const repoId = '11111111-1111-4111-8111-111111111111';
const canonicalId = 'spec:project:cache';
const assetKey = memoryHash('asset');
async function fixture(id = canonicalId) {
  const root = await mkdtemp(join(tmpdir(), 'maestro-memory-runtime-')); roots.push(root);
  const workflow = join(root, '.workflow'); await mkdir(workflow);
  await writeFile(join(workflow, 'repository.json'), JSON.stringify({ schema_version: 'repository-identity/1.0', repo_id: repoId,
    repo_name: 'test', created_at: '2026-01-01T00:00:00.000Z' }));
  let content: string | null = null;
  let local = snapshot('one', id);
  const config = { id: 'wiki', kind: 'tencent-wiki', enabled: true, writeEnabled: true, baseUrl: 'http://127.0.0.1:8421',
    serviceId: 'service', knowledgeId: 'wiki', apiKeyEnv: 'KEY', repoId, teamId: 'team', userId: 'user', agentId: 'agent', timeoutMs: 1000 } as TencentProviderConfig;
  const adapter: MemoryProjectionAdapter = { namespace: 'tencent:namespace', assetKey,
    assertReady: vi.fn(async () => undefined), read: vi.fn(async () => content),
    write: vi.fn(async (_ref, body) => { content = body; }), remove: vi.fn(async () => { content = null; return { deletedPages: [], rewrittenFiles: [], rewrittenFileCount: 2 }; }),
    verifySearch: vi.fn(async () => true) };
  const dependencies: MemoryRuntimeDependencies = { assetStateRoot: join(root, 'host-assets'), capture: vi.fn(async () => local), loadConfigs: vi.fn(() => [config]),
    createAdapter: vi.fn(() => ({ ...adapter,
      write: async (ref, body, ctx) => { await adapter.assertReady(ctx); await ctx.beforeMutationSend?.(); ctx.onMutationSend?.(); return adapter.write(ref, body, ctx); },
      remove: async (ref, ctx) => { await adapter.assertReady(ctx); await ctx.beforeMutationSend?.(); ctx.onMutationSend?.(); return adapter.remove(ref, ctx); },
    })) };
  const run = (r: Partial<MemoryProjectionRequest> = {}) => runMemoryProjection({ action: 'preview', providerId: 'wiki', canonicalId: id, ...r }, { projectRoot: root }, dependencies);
  const save = (operationId = 'save-one') => run({ action: 'save', write: true, ackNoRemoteCas: true, operationId, expectedRecordHash: local.recordHash });
  return { root, workflow, adapter, dependencies, config, run, save, local: () => local, setLocal: (text: string) => { local = snapshot(text, id); }, remote: () => content, setRemote: (text: string | null) => { content = text; } };
}
function snapshot(text: string, id = canonicalId): CanonicalMemorySnapshot {
  const pageContent = `---\nlocked: true\n---\n${text}`;
  return { canonicalId: id, repoId, recordHash: memoryHash(text), sourceFileHash: memoryHash('file'+text), remoteContentHash: memoryHash(pageContent), pageContent,
    pageRef: `wiki/maestro/${repoId}/${memoryHash(id)}.md`, entry: { title: 'Cache policy', body: text } as CanonicalMemorySnapshot['entry'] };
}
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
describe('explicit projection runtime', () => {
  it('preview and status are local-only even with invalid configuration and credential traps', async () => {
    const f = await fixture(); f.dependencies.loadConfigs = () => { throw new Error('must not read config'); };
    const env = new Proxy({}, { get() { throw new Error('credential access'); } }); f.dependencies.env = env;
    expect((await f.run()).status).toBe('preview');
    expect((await f.run({ action: 'status' })).status).toBe('not-managed');
    expect(f.dependencies.createAdapter).not.toHaveBeenCalled();
  });
  it('rejects probes before config and all unacknowledged writes', async () => {
    const f = await fixture(); f.dependencies.loadConfigs = () => { throw new Error('no config'); };
    await expect(runMemoryProjection({ action: 'save', providerId: 'wiki', canonicalId, operationId: 'one', write: true, ackNoRemoteCas: true,
      expectedRecordHash: f.local().recordHash }, { projectRoot: f.root, executionMode: 'read-only-probe' }, f.dependencies)).rejects.toMatchObject({ code: 'probe-forbidden' });
    for (const patch of [{ write: false }, { ackNoRemoteCas: false }, { operationId: undefined }, { expectedRecordHash: undefined }]) {
      await expect(f.run({ action: 'save', write: true, ackNoRemoteCas: true, operationId: 'one', expectedRecordHash: f.local().recordHash, ...patch })).rejects.toMatchObject({ code: 'invalid-request' });
    }
  });
  it('save verifies raw bytes/search separately, replays without another HTTP write and never changes source', async () => {
    const f = await fixture(); const first = await f.save();
    expect(first.status).toBe('stored'); expect(first.receipt?.searchability).toBe('verified');
    expect(await f.save()).toEqual(first); expect(f.adapter.write).toHaveBeenCalledTimes(1);
    expect((await f.run({ action: 'status' })).receipt).toEqual(first.receipt);
    f.setLocal('two');
    await expect(f.save()).rejects.toMatchObject({ code: 'operation-conflict' });
    expect(f.remote()).toBe(snapshot('one').pageContent);
  });
  it('missing search visibility never causes a second write', async () => {
    const f = await fixture(); vi.mocked(f.adapter.verifySearch).mockRejectedValue(new Error('index error secret'));
    const stored = await f.save(); expect(stored.status).toBe('stored-search-unverified');
    vi.mocked(f.adapter.verifySearch).mockResolvedValue(true);
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('stored');
    expect(f.adapter.write).toHaveBeenCalledTimes(1);
  });
  it('update checks remote and local hashes and remove preserves missing local source', async () => {
    const f = await fixture(); const first = (await f.save()).receipt!; f.setLocal('two');
    const update = { action: 'update' as const, operationId: 'update-one', write: true, ackNoRemoteCas: true, expectedRecordHash: f.local().recordHash, expectedRemoteHash: first.desiredRemoteHash };
    f.setRemote('external change'); await expect(f.run(update)).rejects.toMatchObject({ code: 'remote-conflict' });
    await expect(f.run({ ...update, expectedRemoteHash: memoryHash('external change') })).rejects.toMatchObject({ code: 'hash-mismatch' });
    f.setRemote(snapshot('one').pageContent); const updated = (await f.run(update)).receipt!;
    f.dependencies.capture = async () => { throw new Error('local source removed'); };
    const remove = { action: 'remove' as const, operationId: 'remove-one', write: true, ackNoRemoteCas: true, expectedRemoteHash: updated.desiredRemoteHash };
    await expect(f.run(remove)).rejects.toMatchObject({ code: 'invalid-request' });
    const removed = await f.run({ ...remove, ackCascade: true });
    expect(removed.status).toBe('removed'); expect(removed.receipt?.effects?.rewrittenFileCount).toBe(2); expect(f.remote()).toBeNull();
    expect(f.adapter.remove).toHaveBeenCalledTimes(1);
  });
  it('post-send failures persist indeterminate and read-only reconciliation never resends', async () => {
    const f = await fixture(); vi.mocked(f.adapter.write).mockImplementation(async (_ref, body) => { f.setRemote(body); throw new Error('lost response token'); });
    expect((await f.save()).status).toBe('indeterminate');
    expect((await f.save()).status).toBe('indeterminate');
    await expect(f.save('another-id')).rejects.toMatchObject({ code: 'pending-operation' });
    for (const action of ['update', 'remove'] as const) {
      await expect(f.run({ action, operationId: `unsafe-${action}`, write: true, ackNoRemoteCas: true,
        ...(action === 'update' ? { expectedRecordHash: f.local().recordHash } : { ackCascade: true }),
        expectedRemoteHash: memoryHash(f.remote()!) })).rejects.toMatchObject({ code: 'pending-operation' });
    }
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('stored');
    expect(f.adapter.write).toHaveBeenCalledTimes(1);
  });
  it('old/missing observed state cannot prove a failed write was never applied', async () => {
    const f = await fixture(); vi.mocked(f.adapter.write).mockRejectedValue(new Error('timeout'));
    await f.save();
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('indeterminate');
    expect(f.adapter.write).toHaveBeenCalledTimes(1);
  });
  it('durable pending survives failure to persist post-send confirmation', async () => {
    const f = await fixture();
    vi.mocked(f.adapter.write).mockImplementation(async (_ref, body) => {
      f.setRemote(body);
      const dir = join(f.workflow, 'memory-projections');
      const name = (await readdir(dir)).find(p => p.endsWith('.json'))!;
      await writeFile(join(dir, name), 'corrupt');
    });
    await expect(f.save()).rejects.toMatchObject({ code: 'state-invalid' });
    expect(f.adapter.write).toHaveBeenCalledTimes(1);
    await expect(f.save('different')).rejects.toMatchObject({ code: 'state-invalid' });
  });
  it('persisted intent exists before mutation and cross-process lock is never stolen', async () => {
    const f = await fixture();
    await withMemoryAssetLock(f.workflow, assetKey, async () => {
      await expect(f.save()).rejects.toMatchObject({ code: 'asset-locked' });
    }, f.dependencies.assetStateRoot);
    vi.mocked(f.adapter.write).mockImplementation(async (_ref, body) => {
      const files = await readdir(join(f.workflow, 'memory-projections'));
      const manifest = JSON.parse(await readFile(join(f.workflow, 'memory-projections', files.find(p => p.endsWith('.json'))!), 'utf8'));
      expect(manifest.receipts.at(-1).state).toBe('pending'); f.setRemote(body);
    });
    await f.save(); expect(f.adapter.write).toHaveBeenCalledTimes(1);
  });
  it('rechecks source and live write configuration before send', async () => {
    const f = await fixture();
    vi.mocked(f.dependencies.capture!).mockResolvedValueOnce(snapshot('one')).mockResolvedValueOnce(snapshot('changed'));
    await expect(f.save()).rejects.toMatchObject({ code: 'source-changed' });
    vi.mocked(f.dependencies.capture!).mockResolvedValue(snapshot('one'));
    vi.mocked(f.adapter.read).mockImplementationOnce(async () => { f.config.writeEnabled = false; return null; });
    await expect(f.save()).rejects.toMatchObject({ code: 'write-disabled' });
    expect(f.adapter.write).not.toHaveBeenCalled();
  });
  it('fails closed on scope changes, config disablement and mismatched expected hashes', async () => {
    const f = await fixture();
    await expect(f.run({ action: 'save', operationId: 'one', write: true, ackNoRemoteCas: true, expectedRecordHash: memoryHash('wrong') })).rejects.toMatchObject({ code: 'hash-mismatch' });
    f.config.enabled = false; await expect(f.save()).rejects.toMatchObject({ code: 'disabled-provider' });
    f.config.enabled = true; f.config.repoId = 'other'; await expect(f.save()).rejects.toMatchObject({ code: 'scope-mismatch' });
    f.config.repoId = repoId; f.config.writeEnabled = false; await expect(f.save()).rejects.toMatchObject({ code: 'write-disabled' });
    expect(f.adapter.write).not.toHaveBeenCalled();
  });
  it('host context lifecycle fence fails before any mutation', async () => {
    const f = await fixture(); await expect(runMemoryProjection({ action: 'save', providerId: 'wiki', canonicalId, operationId: 'one', write: true,
      ackNoRemoteCas: true, expectedRecordHash: f.local().recordHash }, { projectRoot: f.root, assertCurrent: () => false }, f.dependencies)).rejects.toMatchObject({ code: 'scope-mismatch' });
    expect(f.dependencies.createAdapter).not.toHaveBeenCalled();
  });
  it('rejects linked state directories without following them', async () => {
    const f = await fixture(); const other = await mkdtemp(join(tmpdir(), 'maestro-memory-outside-')); roots.push(other);
    await symlink(other, join(f.workflow, 'memory-projections'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.save()).rejects.toMatchObject({ code: 'state-invalid' }); expect(f.adapter.write).not.toHaveBeenCalled();
  });
  it('reconciliation cannot rewrite newer ownership using a historical operation ID', async () => {
    const f = await fixture(); const saved = (await f.save()).receipt!; f.setLocal('two');
    await f.run({ action: 'update', operationId: 'newer', write: true, ackNoRemoteCas: true,
      expectedRecordHash: f.local().recordHash, expectedRemoteHash: saved.desiredRemoteHash });
    await expect(f.run({ action: 'reconcile', operationId: 'save-one' })).rejects.toMatchObject({ code: 'operation-conflict' });
    expect((await f.run({ action: 'status' })).receipt?.operationId).toBe('newer');
  });
  it('a lost delete response reconciles absence without resending cascade deletion', async () => {
    const f = await fixture(); const saved = (await f.save()).receipt!;
    vi.mocked(f.adapter.remove).mockImplementation(async () => { f.setRemote(null); throw new Error('lost'); });
    const removed = await f.run({ action: 'remove', operationId: 'delete', write: true, ackNoRemoteCas: true,
      ackCascade: true, expectedRemoteHash: saved.desiredRemoteHash });
    expect(removed.status).toBe('indeterminate');
    expect((await f.run({ action: 'reconcile', operationId: 'delete' })).status).toBe('removed');
    expect(f.adapter.remove).toHaveBeenCalledTimes(1);
  });
  it('a readback mismatch remains indeterminate, never stored or searchable', async () => {
    const f = await fixture(); vi.mocked(f.adapter.write).mockImplementation(async () => { f.setRemote('other bytes'); });
    expect((await f.save()).status).toBe('indeterminate'); expect(f.adapter.verifySearch).not.toHaveBeenCalled();
  });
  it('blocks unresolved sends across physical repositories sharing the asset ledger', async () => {
    const first = await fixture(); const second = await fixture(); second.dependencies.assetStateRoot = first.dependencies.assetStateRoot;
    vi.mocked(first.adapter.write).mockRejectedValue(new Error('lost reply'));
    expect((await first.save()).status).toBe('indeterminate');
    await expect(second.save('other-worktree')).rejects.toMatchObject({ code: 'pending-operation' });
    expect(second.adapter.write).not.toHaveBeenCalled();
    first.setRemote(first.local().pageContent);
    expect((await first.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('stored');
    expect((await second.save('other-worktree')).status).toBe('stored');
  });
  it('invalidates another physical repository receipt after a cascade send', async () => {
    const first = await fixture(); const second = await fixture(); second.dependencies.assetStateRoot = first.dependencies.assetStateRoot;
    const saved = (await first.save()).receipt!; await second.save('second-save');
    await second.run({ action: 'remove', operationId: 'cascade', write: true, ackNoRemoteCas: true, ackCascade: true,
      expectedRemoteHash: second.local().remoteContentHash });
    expect((await first.run({ action: 'status' })).status).toBe('invalidated');
    expect((await first.save()).status).toBe('invalidated');
    expect(saved.state).toBe('stored'); // Prior immutable result is historical, not live status.
  });
  it.each(['update', 'remove'] as const)('explicitly recovers an actually cascade-rewritten projection by %s without adopting its hash', async action => {
    const first = await fixture(); const second = await fixture('spec:project:other');
    second.dependencies.assetStateRoot = first.dependencies.assetStateRoot;
    const pages = new Map<string, string>();
    for (const f of [first, second]) {
      vi.mocked(f.adapter.read).mockImplementation(async ref => pages.get(ref) ?? null);
      vi.mocked(f.adapter.write).mockImplementation(async (ref, body) => { pages.set(ref, body); });
      vi.mocked(f.adapter.remove).mockImplementation(async ref => { pages.delete(ref); return { deletedPages: [ref], rewrittenFiles: [] }; });
    }
    const link = `[other](${second.local().pageRef})`;
    first.setLocal(`one ${link}`);
    const source = first.local(); const saved = (await first.save()).receipt!;
    const other = (await second.save('other-save')).receipt!;
    vi.mocked(second.adapter.remove).mockImplementation(async ref => {
      pages.delete(ref);
      pages.set(saved.pageRef, pages.get(saved.pageRef)!.replace(link, 'other'));
      return { deletedPages: [ref], rewrittenFiles: [saved.pageRef] };
    });
    expect((await second.run({ action: 'remove', operationId: 'cascade', write: true, ackNoRemoteCas: true,
      ackCascade: true, expectedRemoteHash: other.desiredRemoteHash })).status).toBe('removed');
    const rewritten = pages.get(saved.pageRef)!; const reviewedHash = memoryHash(rewritten);
    expect(reviewedHash).not.toBe(saved.desiredRemoteHash);
    expect(first.local()).toEqual(source); // Remote cascade never edits canonical memory.
    expect((await first.run({ action: 'status' })).status).toBe('invalidated');
    const reconciled = await first.run({ action: 'reconcile', operationId: 'save-one' });
    expect(reconciled.status).toBe('invalidated');
    expect(reconciled.receipt?.desiredRemoteHash).toBe(saved.desiredRemoteHash);
    expect((await first.save()).status).toBe('invalidated'); // Replay never silently repairs.
    expect(pages.get(saved.pageRef)).toBe(rewritten);
    expect(first.adapter.write).toHaveBeenCalledTimes(1); expect(first.adapter.remove).not.toHaveBeenCalled();
    const recovery = { action, operationId: 'explicit-recovery', write: true, ackNoRemoteCas: true,
      ...(action === 'update' ? { expectedRecordHash: source.recordHash } : { ackCascade: true }), expectedRemoteHash: reviewedHash };
    await expect(first.run({ ...recovery, write: false })).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(first.run({ ...recovery, expectedRemoteHash: saved.desiredRemoteHash })).rejects.toMatchObject({ code: 'remote-conflict' });
    pages.set(saved.pageRef, 'external writer raced before preflight');
    await expect(first.run(recovery)).rejects.toMatchObject({ code: 'remote-conflict' });
    pages.set(saved.pageRef, rewritten);
    const recovered = await first.run(recovery);
    expect(recovered.status).toBe(action === 'update' ? 'stored' : 'removed');
    expect(recovered.receipt?.expectedRemoteHash).toBe(reviewedHash);
    expect(pages.get(saved.pageRef)).toBe(action === 'update' ? source.pageContent : undefined);
    expect(await first.run(recovery)).toEqual(recovered);
    const manifest = await loadMemoryManifest(first.workflow, assetKey);
    expect(manifest.receipts[0]).toMatchObject({ state: 'invalidated', desiredRemoteHash: saved.desiredRemoteHash });
    expect(first.adapter.write).toHaveBeenCalledTimes(action === 'update' ? 2 : 1);
    expect(first.adapter.remove).toHaveBeenCalledTimes(action === 'remove' ? 1 : 0);
  });
  it('does not recreate an absent invalidated page, and restores only the original desired bytes on reconciliation', async () => {
    const f = await fixture(); const saved = (await f.save()).receipt!;
    const ledger = await loadMemoryAssetLedger(assetKey, f.dependencies.assetStateRoot); ledger.cascadeEpoch++;
    await persistMemoryAssetLedger(ledger, f.dependencies.assetStateRoot);
    f.setRemote(null);
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('invalidated');
    await expect(f.run({ action: 'update', operationId: 'no-recreate', write: true, ackNoRemoteCas: true,
      expectedRecordHash: f.local().recordHash, expectedRemoteHash: saved.desiredRemoteHash })).rejects.toMatchObject({ code: 'remote-conflict' });
    await expect(f.save('no-save-over-invalidation')).rejects.toMatchObject({ code: 'remote-conflict' });
    f.setRemote(f.local().pageContent);
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('stored');
    expect(f.adapter.write).toHaveBeenCalledTimes(1); expect(f.adapter.remove).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'rewritten'] as const)('persists 2049 short %s paths from the real adapter without leaving a pending delete', async kind => {
    const f = await fixture();
    const paths = Array.from({ length: 2049 }, (_, i) => i.toString(36));
    const deletedPages = kind === 'deleted' ? [f.local().pageRef, ...paths.slice(1)] : [f.local().pageRef];
    const rewrittenFiles = kind === 'rewritten' ? paths : [];
    const effects = { deletedPages, rewrittenFiles, rewrittenFileCount: rewrittenFiles.length };
    expect(Buffer.byteLength(JSON.stringify(effects))).toBeLessThan(16_384);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const body = JSON.parse(String(init!.body));
      let data: unknown;
      switch (new URL(String(url)).pathname) {
        case '/v3/wiki/get': data = { wiki_id: 'wiki', team_id: 'team', status: 'ready' }; break;
        case '/v3/wiki/page/read': data = { items: [{ ref: body.refs[0], ...(f.remote() === null ? { not_found: true } : { content: f.remote() }) }] }; break;
        case '/v3/wiki/page/write': f.setRemote(body.pages[0].content); data = { items: [{ ref: body.pages[0].ref, locked_injected: false }] }; break;
        case '/v3/wiki/page/rm': f.setRemote(null); data = { deleted_pages: deletedPages, rewritten_files: rewrittenFiles }; break;
        case '/v3/tools/call': data = { results: [], count: 0 }; break;
        default: throw new Error(`Unexpected mock request ${url}`);
      }
      return Response.json({ code: 0, data });
    });
    const adapter = createTencentMemoryAdapter(f.config, { fetch, env: { KEY: 'synthetic' } });
    f.dependencies.createAdapter = () => adapter;
    const saved = (await f.save()).receipt!;
    const request = { action: 'remove' as const, operationId: 'many-paths', write: true, ackNoRemoteCas: true,
      ackCascade: true, expectedRemoteHash: saved.desiredRemoteHash };
    const removed = await f.run(request);
    expect(removed.status).toBe('removed'); expect(removed.receipt?.effects).toEqual(effects);
    expect((await loadMemoryManifest(f.workflow, adapter.assetKey)).receipts.at(-1)).toEqual(removed.receipt);
    expect((await loadMemoryAssetLedger(adapter.assetKey, f.dependencies.assetStateRoot)).pending).toBeUndefined();
    expect((await f.run({ action: 'status' })).receipt).toEqual(removed.receipt);
    expect(await f.run(request)).toEqual(removed);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/v3/wiki/page/rm'))).toHaveLength(1);
  });
  it('known-unsent readiness failures remain retryable with a new ID and do not invalidate cascades', async () => {
    const f = await fixture(); const saved = (await f.save()).receipt!;
    vi.mocked(f.adapter.assertReady).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ready preflight unavailable'));
    const request = { action: 'remove' as const, operationId: 'not-sent', write: true, ackNoRemoteCas: true, ackCascade: true,
      expectedRemoteHash: saved.desiredRemoteHash };
    expect((await f.run(request)).status).toBe('not-sent');
    expect(f.adapter.remove).not.toHaveBeenCalled();
    expect((await f.run({ action: 'reconcile', operationId: 'not-sent' })).status).toBe('not-sent');
    vi.mocked(f.adapter.assertReady).mockResolvedValue(undefined);
    expect((await f.run({ ...request, operationId: 'sent-now' })).status).toBe('removed');
  });
  it('clears a prepared but unsent cascade gate without invalidating another repository', async () => {
    const first = await fixture(); const second = await fixture(); second.dependencies.assetStateRoot = first.dependencies.assetStateRoot;
    await first.save(); const saved = (await second.save('other-save')).receipt!;
    second.dependencies.createAdapter = () => ({ ...second.adapter, remove: async (_ref, ctx) => {
      await ctx.beforeMutationSend?.(); second.config.writeEnabled = false; ctx.assertMutationCurrent?.();
      throw new Error('must not get here');
    } });
    const failed = await second.run({ action: 'remove', operationId: 'revoked', write: true, ackNoRemoteCas: true,
      ackCascade: true, expectedRemoteHash: saved.desiredRemoteHash });
    expect(failed.status).toBe('not-sent'); expect(second.adapter.remove).not.toHaveBeenCalled();
    expect((await first.run({ action: 'status' })).status).toBe('stored');
    first.setLocal('fresh');
    expect((await first.run({ action: 'update', operationId: 'after-revocation', write: true, ackNoRemoteCas: true,
      expectedRecordHash: first.local().recordHash, expectedRemoteHash: snapshot('one').remoteContentHash })).status).toBe('stored');
  });
  it('recovers a crash after local pending persistence but before the durable send marker', async () => {
    const f = await fixture();
    vi.mocked(f.adapter.assertReady).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unsent'));
    await f.save();
    const local = await loadMemoryManifest(f.workflow, assetKey);
    local.receipts[0].state = 'pending'; // Simulate the persisted bytes at this exact crash window.
    await persistMemoryManifest(f.workflow, local);
    const beforeReads = vi.mocked(f.adapter.read).mock.calls.length;
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('not-sent');
    expect(vi.mocked(f.adapter.read).mock.calls.length).toBe(beforeReads); // Durable ordering proves unsent, no network needed.
    vi.mocked(f.adapter.assertReady).mockResolvedValue(undefined);
    expect((await f.save('fresh-after-crash')).status).toBe('stored');
    expect(f.adapter.write).toHaveBeenCalledTimes(1);
  });
  it('cannot infer unsent from a missing or replaced ledger generation', async () => {
    const f = await fixture();
    vi.mocked(f.adapter.assertReady).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unsent'));
    await f.save();
    const local = await loadMemoryManifest(f.workflow, assetKey); local.receipts[0].state = 'pending';
    await persistMemoryManifest(f.workflow, local);
    const ledger = await loadMemoryAssetLedger(assetKey, f.dependencies.assetStateRoot); ledger.generation = memoryHash('replaced');
    await persistMemoryAssetLedger(ledger, f.dependencies.assetStateRoot);
    vi.mocked(f.adapter.assertReady).mockResolvedValue(undefined);
    expect((await f.run({ action: 'reconcile', operationId: 'save-one' })).status).toBe('indeterminate');
    await expect(f.save('fresh')).rejects.toMatchObject({ code: 'pending-operation' });
    expect(f.adapter.write).not.toHaveBeenCalled();
  });
  it('strict allowlist refuses arbitrary root, remote path or body inputs', () => {
    for (const extra of [{ projectRoot: '/tmp' }, { pageRef: 'wiki/other.md' }, { body: 'new' }, { action: 'ingest' }, { providerId: 'local' }, { write: true }]) {
      expect(() => validateMemoryProjectionRequest({ action: 'preview', providerId: 'wiki', canonicalId, ...extra })).toThrow('invalid-request');
    }
  });
});
