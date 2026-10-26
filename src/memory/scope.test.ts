import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMemoryRepository } from './scope.js';
const roots: string[] = [];
const identity = { schema_version: 'repository-identity/1.0', repo_id: '11111111-1111-4111-8111-111111111111', repo_name: 'Synthetic', created_at: '2026-01-01T00:00:00.000Z' };
function fixture() { const root = mkdtempSync(join(tmpdir(), 'maestro-memory-scope-')); roots.push(root); mkdirSync(join(root, '.workflow')); writeFileSync(join(root, '.workflow', 'repository.json'), JSON.stringify(identity)); return root; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
describe('bounded current-only memory authority', () => {
  it('resolves a physical ancestor without reading unrelated linked configuration', () => {
    const root = fixture(); mkdirSync(join(root, 'nested')); writeFileSync(join(root, '.workflow', 'config.json'), 'invalid unrelated linked config');
    expect(resolveMemoryRepository(join(root, 'nested'))).toMatchObject({ projectRoot: root, repoId: identity.repo_id, relation: 'current' });
  });
  it.each(['corrupt', 'oversized', 'missing', 'directory'])('fails closed on %s identity files', kind => {
    const root = fixture(); const path = join(root, '.workflow', 'repository.json');
    rmSync(path); if (kind === 'directory') mkdirSync(path);
    else if (kind !== 'missing') writeFileSync(path, kind === 'oversized' ? 'x'.repeat(16_385) : 'invalid');
    expect(() => resolveMemoryRepository(root)).toThrow('scope-mismatch');
  });
  it('rejects workflow junctions/symlinks before following their metadata', () => {
    const root = fixture(); const other = fixture(); rmSync(join(root, '.workflow'), { recursive: true });
    symlinkSync(join(other, '.workflow'), join(root, '.workflow'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveMemoryRepository(root)).toThrow('scope-mismatch');
  });
  it.skipIf(process.platform === 'win32')('rejects FIFO identities without opening them in blocking mode', () => {
    const root = fixture(); const path = join(root, '.workflow', 'repository.json'); rmSync(path); execFileSync('mkfifo', [path]);
    expect(() => resolveMemoryRepository(root)).toThrow('scope-mismatch');
  });
});
