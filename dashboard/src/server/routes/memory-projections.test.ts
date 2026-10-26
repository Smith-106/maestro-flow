import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectionError, MEMORY_PROJECTION_SCHEMA, type MemoryProjectionContext, type MemoryProjectionResult } from '../../../../shared/memory-projection.js';
import { runMemoryProjection, validateMemoryProjectionRequest } from '../../../../src/memory/runtime.js';
import { registerMemoryProjectionRoutes } from './memory-projections.js';

vi.mock('../../../../src/memory/runtime.js', async original => ({ ...await original<typeof import('../../../../src/memory/runtime.js')>(), runMemoryProjection: vi.fn() }));
const run = vi.mocked(runMemoryProjection);
const base = { action: 'preview', providerId: 'memory', canonicalId: 'spec-cache' };
const save = { ...base, action: 'save', write: true, ackNoRemoteCas: true, operationId: 'op-one', expectedRecordHash: 'a'.repeat(64) };
function result(action: MemoryProjectionResult['action']): MemoryProjectionResult {
  return { schemaVersion: MEMORY_PROJECTION_SCHEMA, action, status: 'not-managed', warnings: [], canonicalMutation: false };
}
function appFor(workflowRoot = '/host/one/.workflow') {
  let current = { workflowRoot };
  let disposed = false;
  const app = new Hono();
  registerMemoryProjectionRoutes(app, () => current, context => !disposed && context === current);
  return { app, switchWorkspace() { current = { workflowRoot: '/host/two/.workflow' }; }, dispose() { disposed = true; } };
}
function post(app: Hono, body: unknown) {
  return app.request('/api/wiki/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  run.mockReset().mockImplementation(async request => result(validateMemoryProjectionRequest(request).action));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Dashboard memory projection API', () => {
  it.each(['preview', 'status', 'reconcile'] as const)('delegates %s without adding write flags', async action => {
    const { app } = appFor();
    const request = { ...base, action, ...(action === 'reconcile' ? { operationId: 'old-op' } : {}) };
    const response = await post(app, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result(action));
    expect(run).toHaveBeenCalledWith(request, expect.objectContaining({ projectRoot: '/host/one', executionMode: 'default', signal: expect.any(AbortSignal) }));
    const context = run.mock.calls[0][1];
    expect(context.assertCurrent?.()).toBe(true);
  });

  it('separates validated probe and deadline controls from the strict runtime request', async () => {
    const response = await post(appFor().app, { ...base, readOnlyProbe: true, timeoutMs: 1234 });
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith(base, expect.objectContaining({ executionMode: 'read-only-probe', timeoutMs: 1234 }));
  });

  it('keeps all mutation gates and cascade acknowledgement in the shared runtime', async () => {
    const { app } = appFor();
    expect((await post(app, save)).status).toBe(200);
    expect(run).toHaveBeenLastCalledWith(save, expect.any(Object));
    for (const key of ['write', 'ackNoRemoteCas', 'operationId', 'expectedRecordHash']) {
      const request: Record<string, unknown> = { ...save }; delete request[key];
      const response = await post(app, request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid-request', canonicalMutation: false });
    }
    const remove = { ...base, action: 'remove', write: true, ackNoRemoteCas: true, operationId: 'op-remove', expectedRemoteHash: 'b'.repeat(64) };
    expect((await post(app, remove)).status).toBe(400);
    expect((await post(app, { ...remove, ackCascade: true })).status).toBe(200);
  });

  it('rejects authority/URL/credential overrides and all unknown keys via the strict runtime', async () => {
    const { app } = appFor();
    for (const key of ['projectRoot', 'workflowRoot', 'executionMode', 'signal', 'assertCurrent', 'dependencies', 'baseUrl', 'apiKeyEnv', 'teamId', 'userId', 'agentId', 'repo', 'authority', 'request']) {
      const response = await post(app, { ...base, [key]: 'forged' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid-request', canonicalMutation: false });
    }
  });

  it.each([{ readOnlyProbe: 'true' }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { timeoutMs: '500' }])('rejects invalid HTTP controls %j before runtime', async controls => {
    expect((await post(appFor().app, { ...base, ...controls })).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('bounds JSON bytes (including streams), verifies UTF-8 and rejects malformed/non-object JSON', async () => {
    const { app } = appFor();
    for (const body of ['{broken', 'null', '[]', 'false', JSON.stringify({ ...base, junk: 'x'.repeat(16_384) })]) {
      const response = await app.request('/api/wiki/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(400);
    }
    for (const contentLength of ['16385', 'invalid', '-1']) {
      expect((await app.request('/api/wiki/memory', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': contentLength }, body: '{}' })).status).toBe(400);
    }
    const malformedUtf8 = await app.request('/api/wiki/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0xc3, 0x28]) });
    expect(malformedUtf8.status).toBe(400);
    expect((await app.request('/api/wiki/memory', { method: 'POST', body: JSON.stringify(base) })).status).toBe(400);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); controller.close(); } });
    const request = new Request('http://localhost/api/wiki/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect((await app.request(request)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels a stalled body when the client aborts', async () => {
    const { app } = appFor();
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request('http://localhost/api/wiki/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: stream, signal: controller.signal, duplex: 'half' } as RequestInit);
    const pending = app.request(request);
    await Promise.resolve(); controller.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: 'aborted', canonicalMutation: false });
    expect(cancel).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['switch', 'dispose'])('passes a live host lifecycle fence and discards stale responses on %s', async lifecycle => {
    const runtime = appFor();
    let finish!: (value: MemoryProjectionResult) => void;
    let started!: (context: MemoryProjectionContext) => void;
    const ready = new Promise<MemoryProjectionContext>(resolve => { started = resolve; });
    run.mockImplementationOnce(async (_request, context) => {
      started(context);
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = post(runtime.app, save);
    const context = await ready;
    expect(context.assertCurrent?.()).toBe(true);
    if (lifecycle === 'switch') runtime.switchWorkspace(); else runtime.dispose();
    expect(context.assertCurrent?.()).toBe(false);
    finish(result('save'));
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'scope-mismatch', canonicalMutation: false });
  });

  it('maps fixed runtime errors and sanitizes unexpected exception text', async () => {
    const { app } = appFor();
    for (const [code, status] of [['write-disabled', 403], ['probe-forbidden', 403], ['unknown-provider', 404], ['hash-mismatch', 409], ['pending-operation', 409], ['timeout', 408]] as const) {
      run.mockRejectedValueOnce(new MemoryProjectionError(code));
      const response = await post(app, base);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code, canonicalMutation: false });
    }
    run.mockRejectedValueOnce(new Error('SECRET upstream credential https://private.test'));
    const response = await post(app, base);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'provider-error', canonicalMutation: false });
  });

  it('runs real local preview/status and probe rejection in an isolated synthetic repo without network or source edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-api-'));
    try {
      const workflowRoot = join(root, '.workflow');
      await mkdir(join(workflowRoot, 'specs'), { recursive: true });
      await writeFile(join(workflowRoot, 'repository.json'), JSON.stringify({ schema_version: 'repository-identity/1.0',
        repo_id: '11111111-1111-4111-8111-111111111111', repo_name: 'memory-api-test', created_at: '2026-01-01T00:00:00.000Z' }));
      const source = '---\ntitle: Synthetic cache policy\n---\nOnly this synthetic test record.\n';
      const sourcePath = join(workflowRoot, 'specs', 'cache.md');
      await writeFile(sourcePath, source);
      await writeFile(join(workflowRoot, 'search-providers.json'), 'invalid config must not be read');
      const fetch = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', fetch);
      const actual = await vi.importActual<typeof import('../../../../src/memory/runtime.js')>('../../../../src/memory/runtime.js');
      run.mockImplementation(actual.runMemoryProjection);
      const { app } = appFor(workflowRoot);
      const request = { ...base, canonicalId: 'spec:project:cache', readOnlyProbe: true };
      const preview = await post(app, request);
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ action: 'preview', status: 'preview', canonicalMutation: false,
        snapshot: { canonicalId: 'spec:project:cache', entry: { title: 'Synthetic cache policy' } } });
      expect(await (await post(app, { ...request, action: 'status' })).json()).toMatchObject({ status: 'not-managed' });
      const denied = await post(app, { ...save, canonicalId: request.canonicalId, readOnlyProbe: true });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'probe-forbidden', canonicalMutation: false });
      expect(await readFile(sourcePath, 'utf8')).toBe(source);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('is narrowly registered before the existing wiki routes', () => {
    const wiki = readFileSync(new URL('./wiki.ts', import.meta.url), 'utf8');
    expect(wiki).toContain('registerMemoryProjectionRoutes(app, runtime.getContext, runtime.isCurrent)');
  });
});
