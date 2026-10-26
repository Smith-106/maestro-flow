import { constants, openSync, readSync, closeSync, lstatSync, fstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryProjectionError } from '../../shared/memory-projection.js';

export interface MemoryRepositoryContext {
  projectRoot: string; workflowRoot: string; repoId: string; repoName: string;
  relation: 'current'; identityPersisted: true;
}
/** Current physical repository only. Never traverses linked/global configuration.
 * The legacy general resolver uses unbounded synchronous manifest reads; the
 * writable port instead validates one bounded regular no-follow identity file.
 */
export function resolveMemoryRepository(projectRoot: string): MemoryRepositoryContext {
  let fd: number | undefined;
  try {
    let root = realpathSync(projectRoot);
    if (!lstatSync(root).isDirectory()) throw new Error();
    let workflowRoot: string;
    for (;;) {
      workflowRoot = join(root, '.workflow');
      try {
        const stat = lstatSync(workflowRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(root) === root) throw error;
        root = dirname(root);
      }
    }
    const path = join(workflowRoot, 'repository.json');
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16_384n) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error();
    const bytes = Buffer.alloc(16_385);
    let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (size > 16_384 || BigInt(size) !== stat.size || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs ||
        named.dev !== stat.dev || named.ino !== stat.ino || !named.isFile() || named.isSymbolicLink()) throw new Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!value || value.schema_version !== 'repository-identity/1.0' || typeof value.repo_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.repo_id) ||
        typeof value.repo_name !== 'string' || !value.repo_name.trim() || value.repo_name.length > 256 ||
        typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw new Error();
    return { projectRoot: root, workflowRoot, repoId: value.repo_id, repoName: value.repo_name.trim(), relation: 'current', identityPersisted: true };
  } catch { throw new MemoryProjectionError('scope-mismatch'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
