import { constants, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { SearchProviderError } from '../../../shared/search-provider.js';

export interface TencentProviderConfig {
  id: string;
  kind: 'tencent-atomic' | 'tencent-wiki';
  enabled: boolean;
  writeEnabled?: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  serviceId: string;
  repoId: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  knowledgeId?: string;
  timeoutMs: number;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const FIELDS = new Set(['id', 'kind', 'enabled', 'baseUrl', 'apiKeyEnv', 'serviceId', 'repoId',
  'teamId', 'userId', 'agentId', 'taskId', 'knowledgeId', 'timeoutMs', 'writeEnabled']);
const invalid = (): never => { throw new SearchProviderError('invalid-config'); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Validates programmatic configurations too; URL parsing must not widen loopback aliases. */
export function validateTencentProviderConfig(value: unknown): TencentProviderConfig {
  if (!object(value) || Object.keys(value).some(key => !FIELDS.has(key))) return invalid();
  if (!text(value.id, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id) ||
      value.id.toLowerCase() === 'local' ||
      (value.kind !== 'tencent-atomic' && value.kind !== 'tencent-wiki')) return invalid();
  for (const key of ['baseUrl', 'apiKeyEnv', 'serviceId', 'repoId'] as const) {
    if (!text(value[key], key === 'baseUrl' ? 2048 : 256)) return invalid();
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv as string)) return invalid();
  for (const key of ['teamId', 'userId', 'agentId', 'taskId', 'knowledgeId'] as const) {
    if (key in value && !text(value[key])) return invalid();
  }
  if (value.kind === 'tencent-atomic' &&
      !['teamId', 'userId', 'agentId'].every(key => text(value[key]))) return invalid();
  if (value.kind === 'tencent-wiki' && !text(value.knowledgeId)) return invalid();
  if ('enabled' in value && typeof value.enabled !== 'boolean') return invalid();
  if ('writeEnabled' in value && typeof value.writeEnabled !== 'boolean') return invalid();
  if (value.writeEnabled === true && (value.kind !== 'tencent-wiki' ||
      !['teamId', 'userId', 'agentId'].every(key => text(value[key])))) return invalid();
  if ('timeoutMs' in value && (!Number.isInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 120_000)) return invalid();
  const raw = value.baseUrl as string;
  if (/[\\?#\s]/.test(raw)) return invalid();
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  const authority = /^[a-z]+:\/\/([^/]+)/i.exec(raw)?.[1];
  if (!authority || authority.includes('@') || url.username || url.password ||
      (url.protocol !== 'https:' && url.protocol !== 'http:')) return invalid();
  if (url.protocol === 'http:' &&
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(authority)) return invalid();
  return { ...value, enabled: value.enabled ?? false, timeoutMs: value.timeoutMs ?? 3000,
    baseUrl: url.href.replace(/\/+$/, '') } as TencentProviderConfig;
}

/** workflowRoot is the already-resolved .workflow directory. Never creates configuration. */
export function loadSearchProviderConfigs(workflowRoot: string): TencentProviderConfig[] {
  let fd: number;
  // Opening a FIFO with 'r' blocks before fstat can reject it. Nonblocking
  // open keeps special files (including symlink targets) inside the time bound.
  try { fd = openSync(join(workflowRoot, 'search-providers.json'), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return invalid();
  }
  let data: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return invalid();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_CONFIG_BYTES) return invalid();
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } catch { return invalid(); }
  finally { closeSync(fd); }
  if (!object(data) || Object.keys(data).some(key => key !== 'version' && key !== 'providers') ||
      data.version !== 1 || !Array.isArray(data.providers) || data.providers.length > 8) return invalid();
  const configs = data.providers.map(validateTencentProviderConfig);
  if (new Set(configs.map(config => config.id)).size !== configs.length) return invalid();
  return configs;
}
