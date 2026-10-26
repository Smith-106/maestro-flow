import { MemoryProjectionError, MEMORY_PROJECTION_ERROR_CODES, type MemoryProjectionResult } from '../../shared/memory-projection.js';
import type { CcwToolResult } from '../types/tool-schema.js';
import { getProjectRoot } from '../utils/path-validator.js';

export const schema = {
  name: 'maestro_memory_store',
  description: 'Preview, save, update, remove, inspect or reconcile an explicitly selected canonical knowledge projection. Local knowledge is never changed. Mutations require write, ackNoRemoteCas and operationId; save/update also require expectedRecordHash, update/remove expectedRemoteHash, remove ackCascade. Upstream has no atomic CAS. Reconcile only reads remote state and repairs local receipts; it never resends a mutation.',
  inputSchema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['preview', 'save', 'update', 'remove', 'status', 'reconcile'] },
      providerId: { type: 'string', minLength: 1, description: 'Explicit configured provider ID; no default or all expansion.' },
      canonicalId: { type: 'string', minLength: 1, description: 'Existing current-project canonical record ID, not a file path or remote ref.' },
      operationId: { type: 'string', minLength: 1 },
      expectedRecordHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      expectedRemoteHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      write: { type: 'boolean' },
      ackNoRemoteCas: { type: 'boolean' },
      ackCascade: { type: 'boolean' },
      readOnlyProbe: { type: 'boolean', description: 'Hermetic control: rejects remote access before config or credentials.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30_000 },
    },
    required: ['action', 'providerId', 'canonicalId'],
  },
};

/** Host root is never accepted in tool parameters. Runtime owns the strict request allowlist. */
export async function handler(params: Record<string, unknown>): Promise<CcwToolResult<MemoryProjectionResult>> {
  try {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new MemoryProjectionError('invalid-request');
    const { readOnlyProbe, timeoutMs, ...request } = params;
    if (readOnlyProbe !== undefined && typeof readOnlyProbe !== 'boolean') throw new MemoryProjectionError('invalid-request');
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) {
      throw new MemoryProjectionError('invalid-request');
    }
    const { runMemoryProjection } = await import('../memory/runtime.js');
    const result = await runMemoryProjection(request, { projectRoot: getProjectRoot(),
      executionMode: readOnlyProbe === true ? 'read-only-probe' : 'default', timeoutMs: timeoutMs as number | undefined });
    return { success: true, result };
  } catch (error) {
    const code = error instanceof MemoryProjectionError && MEMORY_PROJECTION_ERROR_CODES.includes(error.code) ? error.code : 'provider-error';
    return { success: false, error: code };
  }
}
