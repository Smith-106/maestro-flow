import { randomUUID } from 'node:crypto';
import {
  MEMORY_PROJECTION_SCHEMA, MEMORY_PROJECTION_ERROR_CODES, MEMORY_REMOVE_MAX_BYTES, MemoryProjectionError,
  type MemoryProjectionRequest, type MemoryProjectionContext, type MemoryProjectionAdapter,
  type CanonicalMemorySnapshot, type MemoryProjectionReceipt, type MemoryProjectionResult, type MemoryAdapterContext,
} from '../../shared/memory-projection.js';
import { SearchProviderError } from '../../shared/search-provider.js';
import { resolveMemoryRepository } from './scope.js';
const resolveMemoryScope = (projectRoot: string) => ({ current: resolveMemoryRepository(projectRoot) });
import { loadSearchProviderConfigs, type TencentProviderConfig } from '../search/providers/config.js';
import { assertMemoryManifestCapacity, findMemoryReceipt, loadMemoryManifest, MAX_MEMORY_RECEIPTS,
  memoryHash, persistMemoryManifest, withMemoryAssetLock, loadMemoryAssetLedger, persistMemoryAssetLedger,
  refreshMemoryCascade, type MemoryManifest } from './state.js';

export interface MemoryRuntimeDependencies {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  capture?: (projectRoot: string, canonicalId: string) => Promise<CanonicalMemorySnapshot>;
  loadConfigs?: (workflowRoot: string) => TencentProviderConfig[];
  createAdapter?: (config: TencentProviderConfig) => MemoryProjectionAdapter;
  /** Trusted host/test override; never accepted in request JSON. */
  assetStateRoot?: string;
}
const FIELDS = ['action','providerId','canonicalId','operationId','expectedRecordHash','expectedRemoteHash','write','ackNoRemoteCas','ackCascade'];
const ACTIONS = ['preview','save','update','remove','status','reconcile'];
const mutation = (action: string): action is 'save' | 'update' | 'remove' => ['save','update','remove'].includes(action);
function fail(code: ConstructorParameters<typeof MemoryProjectionError>[0]): never { throw new MemoryProjectionError(code); }
export function validateMemoryProjectionRequest(value: unknown): MemoryProjectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-request');
  const r = value as MemoryProjectionRequest;
  if (Object.keys(r).some(key => !FIELDS.includes(key)) || !ACTIONS.includes(r.action) ||
      typeof r.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.providerId) || r.providerId.toLowerCase() === 'local' ||
      typeof r.canonicalId !== 'string' || !r.canonicalId || r.canonicalId.length > 512 || /[\u0000-\u001f\u007f]/.test(r.canonicalId)) fail('invalid-request');
  if (r.operationId !== undefined && (typeof r.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.operationId))) fail('invalid-request');
  for (const key of ['expectedRecordHash','expectedRemoteHash'] as const) {
    if (r[key] !== undefined && (typeof r[key] !== 'string' || !/^[a-f0-9]{64}$/.test(r[key]!))) fail('invalid-request');
  }
  for (const key of ['write','ackNoRemoteCas','ackCascade'] as const) if (r[key] !== undefined && typeof r[key] !== 'boolean') fail('invalid-request');
  if (mutation(r.action)) {
    if (r.write !== true || r.ackNoRemoteCas !== true || !r.operationId) fail('invalid-request');
    if (r.action !== 'remove' && !r.expectedRecordHash) fail('invalid-request');
    if (r.action !== 'save' && !r.expectedRemoteHash) fail('invalid-request');
    if (r.action === 'remove' && r.ackCascade !== true) fail('invalid-request');
    if ((r.action !== 'remove' && r.ackCascade !== undefined) || (r.action === 'save' && r.expectedRemoteHash !== undefined) ||
        (r.action === 'remove' && r.expectedRecordHash !== undefined)) fail('invalid-request');
  } else {
    if (['write','ackNoRemoteCas','ackCascade','expectedRecordHash','expectedRemoteHash'].some(key => key in r)) fail('invalid-request');
    if (r.action === 'reconcile' ? !r.operationId : r.operationId !== undefined) fail('invalid-request');
  }
  return { ...r };
}
const WARNINGS = ['remote-projection-is-reference-only', 'no-remote-cas-external-writers-can-race'];
function result(action: MemoryProjectionRequest['action'], receipt?: MemoryProjectionReceipt): MemoryProjectionResult {
  const status = !receipt ? 'not-managed' : receipt.state === 'stored' && receipt.searchability !== 'verified'
    ? 'stored-search-unverified' : receipt.state;
  return { schemaVersion: MEMORY_PROJECTION_SCHEMA, action, status, ...(receipt ? { receipt } : {}),
    warnings: [...WARNINGS, ...(receipt?.action === 'remove' ? ['delete-may-rewrite-other-pages'] : [])], canonicalMutation: false };
}
function checkContext(context: MemoryProjectionContext, deadlineAt: number): void {
  if (context.signal?.aborted) fail('aborted');
  if (Date.now() >= deadlineAt) fail('timeout');
  if (context.assertCurrent && !context.assertCurrent()) fail('scope-mismatch');
}
function latest(manifest: MemoryManifest, id: string, repoId: string, namespace: string): MemoryProjectionReceipt | undefined {
  return manifest.receipts.findLast(r => r.canonicalId === id && r.repoId === repoId && r.namespace === namespace && r.state !== 'not-sent');
}
function convertError(error: unknown): MemoryProjectionError {
  if (error instanceof MemoryProjectionError) return error;
  if (error instanceof SearchProviderError && (MEMORY_PROJECTION_ERROR_CODES as readonly string[]).includes(error.code)) {
    return new MemoryProjectionError(error.code as ConstructorParameters<typeof MemoryProjectionError>[0]);
  }
  return new MemoryProjectionError('provider-error');
}
/** All entrypoints share this state machine. Dependency injection is host-only, never request JSON. */
export async function runMemoryProjection(
  value: unknown, context: MemoryProjectionContext, dependencies: MemoryRuntimeDependencies = {},
): Promise<MemoryProjectionResult> {
  try { return await run(value, context, dependencies); }
  catch (error) { throw convertError(error); }
}
async function run(value: unknown, context: MemoryProjectionContext, dependencies: MemoryRuntimeDependencies): Promise<MemoryProjectionResult> {
  const r = validateMemoryProjectionRequest(value);
  if (context.executionMode !== undefined && !['default','read-only-probe'].includes(context.executionMode)) fail('invalid-request');
  const timeoutMs = context.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('invalid-request');
  const deadlineAt = Date.now() + timeoutMs;
  checkContext(context, deadlineAt);
  // Preview/status are local-only; every remote operation rejects probe before config or credentials.
  if (context.executionMode === 'read-only-probe' && !['preview','status'].includes(r.action)) fail('probe-forbidden');
  const scope = resolveMemoryScope(context.projectRoot);
  const repoId = scope.current.repoId;
  if (!repoId || scope.current.relation !== 'current') fail('scope-mismatch');
  const capture = dependencies.capture ?? (async (root: string, id: string) =>
    (await import('./snapshot.js')).captureCanonicalMemorySnapshot(root, id));
  if (r.action === 'preview') {
    const snapshot = await capture(scope.current.projectRoot, r.canonicalId);
    checkContext(context, deadlineAt);
    if (snapshot.repoId !== repoId || snapshot.canonicalId !== r.canonicalId) fail('scope-mismatch');
    return { schemaVersion: MEMORY_PROJECTION_SCHEMA, action: r.action, status: 'preview', snapshot,
      warnings: [...WARNINGS, 'preview-does-not-check-remote-configuration-or-existence'], canonicalMutation: false };
  }
  if (r.action === 'status') return result(r.action, await findMemoryReceipt(scope.current.workflowRoot, repoId, r.providerId, r.canonicalId, dependencies.assetStateRoot));
  const loadConfigs = dependencies.loadConfigs ?? loadSearchProviderConfigs;
  const configFor = (): TencentProviderConfig => {
    checkContext(context, deadlineAt);
    const config = loadConfigs(scope.current.workflowRoot).find(c => c.id === r.providerId);
    if (!config) fail('unknown-provider');
    if (!config.enabled) fail('disabled-provider');
    if (config.kind !== 'tencent-wiki') fail('unsupported-source');
    if (config.repoId !== repoId) fail('scope-mismatch');
    if (mutation(r.action) && config.writeEnabled !== true) fail('write-disabled');
    return config;
  };
  const config = configFor();
  const configFingerprint = JSON.stringify(config);
  const assertMutationCurrent = () => {
    checkContext(context, deadlineAt);
    if (JSON.stringify(configFor()) !== configFingerprint) fail('scope-mismatch');
    const current = resolveMemoryScope(context.projectRoot);
    if (current.current.repoId !== repoId || current.current.workflowRoot !== scope.current.workflowRoot) fail('scope-mismatch');
  };
  const adapter = dependencies.createAdapter ? dependencies.createAdapter(config) :
    (await import('./tencent.js')).createTencentMemoryAdapter(config, { fetch: dependencies.fetch, env: dependencies.env });
  const adapterContext: MemoryAdapterContext = { authority: { repoId, workspaceFence: `repo:${repoId}` },
    signal: context.signal ?? new AbortController().signal, deadlineAt, executionMode: context.executionMode ?? 'default', assertMutationCurrent };
  return withMemoryAssetLock(scope.current.workflowRoot, adapter.assetKey, async () => {
    const manifest = await loadMemoryManifest(scope.current.workflowRoot, adapter.assetKey);
    const ledger = await loadMemoryAssetLedger(adapter.assetKey, dependencies.assetStateRoot);
    const owner = memoryHash(scope.current.workflowRoot);
    const ownsPending = (receipt: MemoryProjectionReceipt) => ledger.pending?.owner === owner &&
      ledger.pending.operationId === receipt.operationId && ledger.pending.intentHash === receipt.intentHash;
    const persist = () => persistMemoryManifest(scope.current.workflowRoot, manifest);
    const settleLedger = async (receipt: MemoryProjectionReceipt) => {
      if (!ownsPending(receipt) || ['pending','indeterminate'].includes(receipt.state)) return;
      if (receipt.state === 'not-sent') ledger.cascadeEpoch = ledger.pending!.epochBefore;
      delete ledger.pending;
      await persistMemoryAssetLedger(ledger, dependencies.assetStateRoot);
    };
    if (refreshMemoryCascade(manifest, ledger.cascadeEpoch)) await persist();
    const existing = latest(manifest, r.canonicalId, repoId, adapter.namespace);
    if (r.action === 'reconcile') {
      const receipt = manifest.receipts.find(item => item.operationId === r.operationId);
      if (!receipt || receipt.repoId !== repoId || receipt.namespace !== adapter.namespace || receipt.canonicalId !== r.canonicalId) fail('not-managed');
      if (ledger.pending && !ownsPending(receipt)) fail('pending-operation');
      if (receipt.state === 'not-sent') { await settleLedger(receipt); return result(r.action, receipt); }
      // The ledger generation is persisted BEFORE this local intent, while its
      // pending owner is persisted BEFORE fetch. In the same intact generation,
      // a local pending receipt with no shared send marker proves a pre-send
      // crash. Missing/replaced/legacy ledgers cannot provide that proof.
      if (receipt.state === 'pending' && !ledger.pending && receipt.coordinationId && receipt.coordinationId === ledger.generation) {
        receipt.state = 'not-sent'; receipt.updatedAt = new Date().toISOString(); await persist();
        return result(r.action, receipt);
      }
      // A historical intent must not overwrite the live asset's newer ownership state.
      if (existing !== receipt) fail('operation-conflict');
      checkContext(context, deadlineAt);
      await adapter.assertReady(adapterContext);
      const content = await adapter.read(receipt.pageRef, adapterContext);
      if (receipt.action === 'remove' && content === null) {
        receipt.state = 'removed'; receipt.searchability = 'not-applicable';
        refreshMemoryCascade(manifest, ledger.cascadeEpoch);
      } else if (receipt.action !== 'remove' && content !== null && memoryHash(content) === receipt.desiredRemoteHash) {
        receipt.state = 'stored'; receipt.searchability = 'unverified';
        receipt.updatedAt = new Date().toISOString(); await persist();
        try { if (await adapter.verifySearch(receipt.pageRef, receipt.title, receipt.desiredRemoteHash!, adapterContext)) receipt.searchability = 'verified'; } catch { /* Storage and indexing are independent. */ }
      } else {
        // Cascade invalidation starts from confirmed storage, not an uncertain send.
        // Read-only reconciliation must neither adopt changed bytes nor turn that
        // known outcome into a global ambiguous-write block. Recovery instead needs
        // a fresh explicit update/remove pinned to caller-reviewed current bytes.
        // All genuinely uncertain sends retain the conservative indeterminate gate.
        if (receipt.state !== 'invalidated') receipt.state = 'indeterminate';
        receipt.searchability = 'unverified';
      }
      receipt.updatedAt = new Date().toISOString(); await persist();
      await settleLedger(receipt);
      return result(r.action, receipt);
    }
    if (!mutation(r.action)) fail('invalid-request');
    // Fixed-key digest binds an operation ID to its precise intent, not mutable source content.
    const intentHash = memoryHash(JSON.stringify([r.action, r.providerId, adapter.namespace, repoId, r.canonicalId,
      r.expectedRecordHash ?? null, r.expectedRemoteHash ?? null, r.write, r.ackNoRemoteCas, r.ackCascade ?? null]));
    const replay = manifest.receipts.find(item => item.operationId === r.operationId);
    if (replay) {
      if (replay.intentHash !== intentHash) fail('operation-conflict');
      if (ledger.pending && !ownsPending(replay)) fail('pending-operation');
      await settleLedger(replay);
      return result(r.action, replay);
    }
    if (ledger.pending || manifest.receipts.some(item => ['pending','indeterminate'].includes(item.state))) fail('pending-operation');
    if (manifest.receipts.length >= MAX_MEMORY_RECEIPTS) fail('state-full');
    if (r.action !== 'save' && (!existing || !['stored','invalidated'].includes(existing.state))) fail('not-managed');
    if (r.action === 'save' && existing && !['removed'].includes(existing.state)) fail('remote-conflict');
    // Only a cascade-invalidated, previously confirmed projection can recover
    // against a newly reviewed hash. Do not change its historical desired hash:
    // the new operation records the caller's expectation and checks live bytes
    // below, with the normal explicit write/CAS/cascade acknowledgements.
    if (existing && r.action !== 'save' && existing.state !== 'invalidated' && existing.desiredRemoteHash !== r.expectedRemoteHash) fail('hash-mismatch');
    const snapshot = r.action === 'remove' ? undefined : await capture(scope.current.projectRoot, r.canonicalId);
    checkContext(context, deadlineAt);
    if (snapshot && (snapshot.repoId !== repoId || snapshot.canonicalId !== r.canonicalId)) fail('scope-mismatch');
    if (snapshot && snapshot.recordHash !== r.expectedRecordHash) fail('hash-mismatch');
    const pageRef = snapshot?.pageRef ?? existing!.pageRef;
    await adapter.assertReady(adapterContext);
    const before = await adapter.read(pageRef, adapterContext);
    if (r.action === 'save' ? before !== null : before === null || memoryHash(before) !== r.expectedRemoteHash) fail('remote-conflict');
    // Rebind live physical authority and configuration just before recording send intent.
    const rebound = resolveMemoryScope(context.projectRoot);
    if (rebound.current.repoId !== repoId || rebound.current.workflowRoot !== scope.current.workflowRoot) fail('scope-mismatch');
    const currentConfig = configFor();
    if (JSON.stringify(currentConfig) !== configFingerprint) fail('scope-mismatch');
    if (snapshot) {
      const current = await capture(scope.current.projectRoot, r.canonicalId);
      if (current.recordHash !== snapshot.recordHash || current.sourceFileHash !== snapshot.sourceFileHash || current.remoteContentHash !== snapshot.remoteContentHash) fail('source-changed');
    }
    checkContext(context, deadlineAt);
    // Establish a durable generation before publishing a repository-local
    // pending intent. Reconcile can then distinguish a crash before send-marker
    // creation from a possibly-sent operation, without resending either one.
    if (!ledger.generation) {
      ledger.generation = memoryHash(randomUUID());
      await persistMemoryAssetLedger(ledger, dependencies.assetStateRoot);
    }
    const now = new Date().toISOString();
    const receipt: MemoryProjectionReceipt = { operationId: r.operationId!, intentHash, coordinationId: ledger.generation, action: r.action,
      providerId: r.providerId, namespace: adapter.namespace, assetKey: adapter.assetKey, repoId, canonicalId: r.canonicalId,
      pageRef, title: snapshot?.entry.title ?? existing!.title, ...(snapshot ? { recordHash: snapshot.recordHash,
        sourceFileHash: snapshot.sourceFileHash, desiredRemoteHash: snapshot.remoteContentHash } : {}),
      ...(r.expectedRemoteHash ? { expectedRemoteHash: r.expectedRemoteHash } : {}),
      state: 'pending', searchability: r.action === 'remove' ? 'not-applicable' : 'unverified', createdAt: now, updatedAt: now };
    manifest.receipts.push(receipt);
    // Reserve enough capacity for bounded deletion effects before any send.
    assertMemoryManifestCapacity(manifest, MEMORY_REMOVE_MAX_BYTES);
    await persist();
    let sent = false;
    adapterContext.beforeMutationSend = async () => {
      assertMutationCurrent();
      ledger.pending = { owner, operationId: receipt.operationId, intentHash, action: r.action as 'save' | 'update' | 'remove', epochBefore: ledger.cascadeEpoch };
      if (r.action === 'remove') {
        if (ledger.cascadeEpoch >= Number.MAX_SAFE_INTEGER) fail('state-full');
        ledger.cascadeEpoch++;
      }
      await persistMemoryAssetLedger(ledger, dependencies.assetStateRoot);
      assertMutationCurrent();
    };
    adapterContext.onMutationSend = () => {
      sent = true;
      if (r.action === 'remove') refreshMemoryCascade(manifest, ledger.cascadeEpoch);
    };
    try {
      assertMutationCurrent();
      if (r.action === 'remove') receipt.effects = await adapter.remove(pageRef, adapterContext);
      else await adapter.write(pageRef, snapshot!.pageContent, adapterContext);
      const after = await adapter.read(pageRef, adapterContext);
      if (r.action === 'remove' ? after !== null : after === null || memoryHash(after) !== receipt.desiredRemoteHash) {
        receipt.state = 'indeterminate';
      } else receipt.state = r.action === 'remove' ? 'removed' : 'stored';
    } catch { receipt.state = sent ? 'indeterminate' : 'not-sent'; }
    receipt.updatedAt = new Date().toISOString(); await persist();
    await settleLedger(receipt);
    if (receipt.state === 'stored') {
      try { if (await adapter.verifySearch(pageRef, receipt.title, receipt.desiredRemoteHash!, adapterContext)) receipt.searchability = 'verified'; } catch { /* Never retry a write to repair retrieval. */ }
      receipt.updatedAt = new Date().toISOString(); await persist();
    }
    return result(r.action, receipt);
  }, dependencies.assetStateRoot);
}
