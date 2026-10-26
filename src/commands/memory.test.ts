import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectionError, MEMORY_PROJECTION_SCHEMA, type MemoryProjectionResult } from '../../shared/memory-projection.js';
import { runMemoryProjection, validateMemoryProjectionRequest } from '../memory/runtime.js';
import { registerMemoryCommand } from './memory.js';

vi.mock('../memory/runtime.js', async original => ({ ...await original<typeof import('../memory/runtime.js')>(), runMemoryProjection: vi.fn() }));
vi.mock('../utils/path-validator.js', () => ({ getProjectRoot: () => '/host/project' }));
const run = vi.mocked(runMemoryProjection);
const hash = 'a'.repeat(64), remoteHash = 'b'.repeat(64);
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
function parse(args: string[]) {
  const app = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMemoryCommand(app);
  return app.parseAsync(['memory', ...args], { from: 'user' });
}
function result(action: MemoryProjectionResult['action']): MemoryProjectionResult {
  return { schemaVersion: MEMORY_PROJECTION_SCHEMA, action, status: 'not-managed', warnings: [], canonicalMutation: false };
}
beforeEach(() => {
  run.mockReset().mockImplementation(async request => result(validateMemoryProjectionRequest(request).action));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe('memory CLI thin runtime wrapper', () => {
  it.each(['preview', 'status', 'reconcile'] as const)('forwards %s without manufacturing false write flags', async action => {
    await parse([action, 'spec-cache', '--provider', 'memory', ...(action === 'reconcile' ? ['--operation-id', 'old-op'] : [])]);
    expect(run).toHaveBeenCalledWith({ action, canonicalId: 'spec-cache', providerId: 'memory',
      ...(action === 'reconcile' ? { operationId: 'old-op' } : {}) }, expect.objectContaining({ projectRoot: '/host/project', executionMode: 'default' }));
    expect(output).toHaveBeenCalledWith(JSON.stringify(result(action)));
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(['save', 'update', 'remove'] as const)('forwards explicit %s gates and hashes unchanged', async action => {
    await parse([action, 'spec-cache', '--provider', 'memory', '--write', '--ack-no-remote-cas', '--operation-id', 'op-one',
      ...(action !== 'remove' ? ['--expected-record-hash', hash] : []),
      ...(action !== 'save' ? ['--expected-remote-hash', remoteHash] : []), ...(action === 'remove' ? ['--ack-cascade'] : [])]);
    expect(run).toHaveBeenCalledWith({ action, canonicalId: 'spec-cache', providerId: 'memory', write: true,
      ackNoRemoteCas: true, operationId: 'op-one', ...(action !== 'remove' ? { expectedRecordHash: hash } : {}),
      ...(action !== 'save' ? { expectedRemoteHash: remoteHash } : {}), ...(action === 'remove' ? { ackCascade: true } : {}) }, expect.any(Object));
    expect(errors).not.toHaveBeenCalled();
  });

  it('passes probe/deadline as host context, not request properties', async () => {
    await parse(['preview', 'spec-cache', '--provider', 'memory', '--read-only-probe', '--timeout-ms', '1234', '--json']);
    expect(run).toHaveBeenCalledWith({ action: 'preview', canonicalId: 'spec-cache', providerId: 'memory' },
      { projectRoot: '/host/project', executionMode: 'read-only-probe', timeoutMs: 1234 });
  });

  it.each(['0', '30001', '1.5', 'NaN', '1e3'])('rejects invalid deadline %s before runtime', async timeout => {
    await parse(['preview', 'spec-cache', '--provider', 'memory', '--timeout-ms', timeout]);
    expect(run).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith('{"error":"invalid-request","canonicalMutation":false}');
    expect(process.exitCode).toBe(1);
  });

  it('leaves mutation gates to the shared runtime and reports fixed errors', async () => {
    await parse(['save', 'spec-cache', '--provider', 'memory']);
    expect(run).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith('{"error":"invalid-request","canonicalMutation":false}');
    expect(process.exitCode).toBe(1);
  });

  it('requires explicit provider and rejects model root/URL/tenant overrides and read-only write flags', async () => {
    await expect(parse(['preview', 'spec-cache'])).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    for (const flag of ['--project-root', '--base-url', '--team-id', '--write']) {
      await expect(parse(['preview', 'spec-cache', '--provider', 'memory', flag, 'untrusted'])).rejects.toMatchObject({ code: 'commander.unknownOption' });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected failures and known errors without printing exception messages', async () => {
    run.mockRejectedValueOnce(new Error('SECRET https://private.test credential'));
    await parse(['status', 'spec-cache', '--provider', 'memory']);
    expect(errors).toHaveBeenLastCalledWith('{"error":"provider-error","canonicalMutation":false}');
    run.mockRejectedValueOnce(new MemoryProjectionError('asset-locked'));
    await parse(['status', 'spec-cache', '--provider', 'memory']);
    expect(errors).toHaveBeenLastCalledWith('{"error":"asset-locked","canonicalMutation":false}');
    expect(String(errors.mock.calls)).not.toContain('SECRET');
  });

  it('sanitizes Commander usage output rather than echoing untrusted command names', async () => {
    const writeErr = vi.fn();
    const app = new Command().exitOverride().configureOutput({ writeErr, writeOut: () => {} });
    registerMemoryCommand(app);
    await expect(app.parseAsync(['memory', 'SECRET-unknown-command'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownCommand' });
    expect(writeErr).toHaveBeenCalledWith('{"error":"invalid-request","canonicalMutation":false}\n');
    expect(String(writeErr.mock.calls)).not.toContain('SECRET');
  });

  it('registers the CLI module lazily', () => {
    const cli = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain("memory:     async () => (await import('./commands/memory.js')).registerMemoryCommand");
  });
});
