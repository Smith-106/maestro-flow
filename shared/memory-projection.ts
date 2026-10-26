/** Explicit remote projections of existing canonical records; never an authoring port. */
import type { WikiEntry } from '../dashboard/src/server/wiki/wiki-types.js';
export const MEMORY_PROJECTION_SCHEMA = 'maestro-memory/1.0' as const;
export const MEMORY_PROJECTION_MAX_BYTES = 262_144;
/** Shared adapter/receipt bounds; effects must fit both limits without truncation. */
export const MEMORY_REMOVE_MAX_PATHS = 4096;
export const MEMORY_REMOVE_MAX_BYTES = 16_384;
export type MemoryProjectionAction = 'preview' | 'save' | 'update' | 'remove' | 'status' | 'reconcile';
export interface MemoryProjectionRequest {
  action: MemoryProjectionAction;
  providerId: string;
  canonicalId: string;
  operationId?: string;
  expectedRecordHash?: string;
  expectedRemoteHash?: string;
  write?: boolean;
  ackNoRemoteCas?: boolean;
  ackCascade?: boolean;
}
export interface CanonicalMemorySnapshot {
  entry: WikiEntry;
  canonicalId: string;
  repoId: string;
  sourceFileHash: string;
  recordHash: string;
  pageRef: string;
  pageContent: string;
  remoteContentHash: string;
}
export interface MemoryProjectionContext {
  projectRoot: string;
  executionMode?: 'default' | 'read-only-probe';
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Host lifecycle fence, checked before remote access and immediately before send. */
  assertCurrent?: () => boolean;
}
export interface MemoryAdapterContext {
  authority: { repoId: string; workspaceFence: string };
  signal: AbortSignal;
  deadlineAt: number;
  executionMode: 'default' | 'read-only-probe';
  /** Host-only revalidation after async preflight, immediately before mutation HTTP send. */
  assertMutationCurrent?: () => void;
  /** Persist cross-repository send intent before the transport invokes fetch. */
  beforeMutationSend?: () => Promise<void>;
  /** Synchronous notification at the actual fetch invocation boundary. */
  onMutationSend?: () => void;
}
export interface MemoryRemoveEffects {
  deletedPages: string[];
  rewrittenFiles: string[];
  /** Upstream may report only a count; unknown paths require conservative invalidation. */
  rewrittenFileCount?: number;
}
/** No automatic retries. A mutation rejection after send is potentially applied. */
export interface MemoryProjectionAdapter {
  namespace: string;
  /** Endpoint/service/wiki identity, independent of provider aliases and write switch. */
  assetKey: string;
  assertReady(context: MemoryAdapterContext): Promise<void>;
  read(pageRef: string, context: MemoryAdapterContext): Promise<string | null>;
  write(pageRef: string, content: string, context: MemoryAdapterContext): Promise<void>;
  remove(pageRef: string, context: MemoryAdapterContext): Promise<MemoryRemoveEffects>;
  verifySearch(pageRef: string, title: string, expectedHash: string, context: MemoryAdapterContext): Promise<boolean>;
}
export interface MemoryProjectionReceipt {
  operationId: string;
  intentHash: string;
  /** Generation of the durable host ledger that orders this intent before send. */
  coordinationId?: string;
  action: 'save' | 'update' | 'remove';
  providerId: string;
  namespace: string;
  assetKey: string;
  repoId: string;
  canonicalId: string;
  pageRef: string;
  title: string;
  recordHash?: string;
  sourceFileHash?: string;
  expectedRemoteHash?: string;
  desiredRemoteHash?: string;
  state: 'pending' | 'stored' | 'removed' | 'indeterminate' | 'invalidated' | 'not-sent';
  searchability: 'verified' | 'unverified' | 'not-applicable';
  createdAt: string;
  updatedAt: string;
  effects?: MemoryRemoveEffects;
}
export interface MemoryProjectionResult {
  schemaVersion: typeof MEMORY_PROJECTION_SCHEMA;
  action: MemoryProjectionAction;
  status: 'preview' | 'not-managed' | 'pending' | 'stored' | 'stored-search-unverified' | 'removed' | 'indeterminate' | 'invalidated' | 'not-sent';
  receipt?: MemoryProjectionReceipt;
  snapshot?: CanonicalMemorySnapshot;
  warnings: string[];
  /** The source remains authoritative and is never changed. */
  canonicalMutation: false;
}
export const MEMORY_PROJECTION_ERROR_CODES = [
  'invalid-request', 'invalid-config', 'unknown-provider', 'disabled-provider', 'write-disabled',
  'missing-credential', 'scope-mismatch', 'probe-forbidden', 'aborted', 'timeout',
  'not-found', 'unsupported-source', 'source-changed', 'source-too-large', 'ambiguous-source',
  'hash-mismatch', 'remote-conflict', 'not-managed', 'asset-not-ready', 'operation-conflict',
  'pending-operation', 'state-invalid', 'state-full', 'asset-locked', 'provider-error',
  'remote-http-error', 'remote-response-invalid', 'response-too-large',
] as const;
export type MemoryProjectionErrorCode = typeof MEMORY_PROJECTION_ERROR_CODES[number];
export class MemoryProjectionError extends Error {
  constructor(readonly code: MemoryProjectionErrorCode) { super(code); this.name = 'MemoryProjectionError'; }
}
