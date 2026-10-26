import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectionError, MEMORY_PROJECTION_SCHEMA } from '../../shared/memory-projection.js';
import { runMemoryProjection, validateMemoryProjectionRequest } from '../memory/runtime.js';
import { handler, schema } from './memory-store.js';

vi.mock('../memory/runtime.js', async original => ({ ...await original<typeof import('../memory/runtime.js')>(), runMemoryProjection: vi.fn() }));
vi.mock('../utils/path-validator.js', () => ({ getProjectRoot: () => '/host/project' }));
const run = vi.mocked(runMemoryProjection);
const base = { action: 'preview', providerId: 'memory', canonicalId: 'spec-cache' };
const save = { ...base, action: 'save', write: true, ackNoRemoteCas: true, operationId: 'op-one', expectedRecordHash: 'a'.repeat(64) };
beforeEach(() => {
  run.mockReset().mockImplementation(async request => ({ schemaVersion: MEMORY_PROJECTION_SCHEMA,
    action: validateMemoryProjectionRequest(request).action, status: 'not-managed', warnings: [], canonicalMutation: false }));
});
afterEach(() => vi.restoreAllMocks());

describe('maestro_memory_store thin runtime wrapper', () => {
  it('has a strict schema with no root, credentials, URL or tenant inputs and is registered', () => {
    expect(schema.name).toBe('maestro_memory_store');
    expect(schema.inputSchema.additionalProperties).toBe(false);
    expect(schema.inputSchema.required).toEqual(['action', 'providerId', 'canonicalId']);
    expect(Object.keys(schema.inputSchema.properties)).toEqual(['action', 'providerId', 'canonicalId', 'operationId',
      'expectedRecordHash', 'expectedRemoteHash', 'write', 'ackNoRemoteCas', 'ackCascade', 'readOnlyProbe', 'timeoutMs']);
    const registrations = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(registrations).toContain("import * as memoryStoreTool from './memory-store.js'");
    expect(registrations).toContain('registerCcwTool(registry, memoryStoreTool)');
  });

  it.each(['preview', 'status', 'reconcile'])('forwards %s with no synthetic write flags', async action => {
    const request = { ...base, action, ...(action === 'reconcile' ? { operationId: 'old-op' } : {}) };
    expect(await handler(request)).toMatchObject({ success: true, result: { action, canonicalMutation: false } });
    expect(run).toHaveBeenCalledWith(request, { projectRoot: '/host/project', executionMode: 'default', timeoutMs: undefined });
  });

  it('keeps controls out of runtime request and cannot accept a host root override', async () => {
    expect(await handler({ ...base, readOnlyProbe: true, timeoutMs: 1200 })).toMatchObject({ success: true });
    expect(run).toHaveBeenCalledWith(base, { projectRoot: '/host/project', executionMode: 'read-only-probe', timeoutMs: 1200 });
    for (const key of ['projectRoot', 'workflowRoot', 'executionMode', 'signal', 'assertCurrent', 'dependencies', 'baseUrl', 'apiKeyEnv', 'teamId', 'userId', 'agentId', 'repo', 'authority']) {
      expect(await handler({ ...base, [key]: 'forged' })).toEqual({ success: false, error: 'invalid-request' });
    }
  });

  it.each([{ readOnlyProbe: 'true' }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { timeoutMs: '500' }])('rejects malformed controls %j before runtime', async controls => {
    expect(await handler({ ...base, ...controls })).toEqual({ success: false, error: 'invalid-request' });
    expect(run).not.toHaveBeenCalled();
  });

  it('passes writes unchanged and delegates every required mutation gate to runtime', async () => {
    expect(await handler(save)).toMatchObject({ success: true });
    expect(run).toHaveBeenLastCalledWith(save, expect.any(Object));
    for (const key of ['write', 'ackNoRemoteCas', 'operationId', 'expectedRecordHash']) {
      const request: Record<string, unknown> = { ...save }; delete request[key];
      expect(await handler(request)).toEqual({ success: false, error: 'invalid-request' });
    }
    const remove = { ...base, action: 'remove', write: true, ackNoRemoteCas: true, operationId: 'op-remove', expectedRemoteHash: 'b'.repeat(64) };
    expect(await handler(remove)).toEqual({ success: false, error: 'invalid-request' });
    expect(await handler({ ...remove, ackCascade: true })).toMatchObject({ success: true });
    expect(await handler({ ...base, write: false })).toEqual({ success: false, error: 'invalid-request' });
  });

  it('rejects malformed and unbounded request fields through the runtime validator', async () => {
    for (const patch of [{ providerId: '' }, { providerId: 'local' }, { canonicalId: '' }, { canonicalId: 'a'.repeat(513) },
      { action: 'upload' }, { action: 'reconcile' }, { canonicalId: 'bad\nrecord' }]) {
      expect(await handler({ ...base, ...patch })).toEqual({ success: false, error: 'invalid-request' });
    }
  });

  it('never leaks unexpected exception text or unrecognized error codes', async () => {
    run.mockRejectedValueOnce(new Error('SECRET URL and response body'));
    expect(await handler(base)).toEqual({ success: false, error: 'provider-error' });
    run.mockRejectedValueOnce(new MemoryProjectionError('probe-forbidden'));
    expect(await handler(base)).toEqual({ success: false, error: 'probe-forbidden' });
    const forged = new MemoryProjectionError('provider-error'); Object.assign(forged, { code: 'SECRET' });
    run.mockRejectedValueOnce(forged);
    expect(await handler(base)).toEqual({ success: false, error: 'provider-error' });
  });
});
