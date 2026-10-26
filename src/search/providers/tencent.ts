import { createHash } from 'node:crypto';
import {
  SearchProviderError, SEARCH_PROVIDER_MAX_SOURCE_CHARS,
  type ProviderSearchRequest, type SearchProvider, type SearchCandidate,
  type SearchReference, type SearchProviderErrorCode,
} from '../../../shared/search-provider.js';
import { validateTencentProviderConfig, type TencentProviderConfig } from './config.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = SEARCH_PROVIDER_MAX_SOURCE_CHARS;
const fail = (code: SearchProviderErrorCode): never => { throw new SearchProviderError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length) ||
      /[\u0000]/.test(value)) return fail('remote-response-invalid');
  return value;
}
function score(value: unknown): SearchCandidate['rawScore'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail('remote-response-invalid');
  return { value, metric: 'tencent-score' };
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    !/[\\:%?#\u0000-\u0020\u007f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** No credentials or config alias in the identity; changing a binding invalidates old refs. */
export function tencentProviderNamespace(config: TencentProviderConfig): string {
  const c = validateTencentProviderConfig(config);
  return `tencent:${createHash('sha256').update(JSON.stringify([
    c.kind, c.baseUrl, c.serviceId, c.teamId ?? null, c.userId ?? null,
    c.agentId ?? null, c.taskId ?? null, c.knowledgeId ?? null, c.repoId,
  ])).digest('hex')}`;
}

type Context = Pick<ProviderSearchRequest, 'authority' | 'signal' | 'deadlineAt' | 'executionMode'>;

const TENCENT_PATHS = ['/v3/atomic/search', '/v3/tools/call', '/v3/wiki/get',
  '/v3/wiki/page/read', '/v3/wiki/page/write', '/v3/wiki/page/rm'] as const;
type TencentPath = typeof TENCENT_PATHS[number];

/** Internal bounded transport shared by read providers and explicit memory projections. No retries. */
export function createTencentTransport(
  config: TencentProviderConfig,
  options: { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv } = {},
) {
  const c = validateTencentProviderConfig(config);

  function authorize(context: Context): void {
    if (context.executionMode === 'read-only-probe') fail('probe-forbidden');
    if (context.executionMode !== 'default') fail('invalid-request');
    if (!context.authority || context.authority.repoId !== c.repoId ||
        typeof context.authority.workspaceFence !== 'string' || !context.authority.workspaceFence) fail('scope-mismatch');
    if (!c.enabled) fail('disabled-provider');
    if (!Number.isFinite(context.deadlineAt) || !context.signal ||
        typeof context.signal.addEventListener !== 'function') fail('invalid-request');
    if (context.signal.aborted) fail('aborted');
    if (context.deadlineAt <= Date.now()) fail('timeout');
  }

  async function post(path: TencentPath, body: unknown, context: Context,
    send?: { before?: () => Promise<void>; invoked?: () => void }): Promise<Record<string, unknown>> {
    authorize(context);
    if (!TENCENT_PATHS.includes(path)) return fail('invalid-request');
    const key = (options.env ?? process.env)[c.apiKeyEnv];
    if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key)) fail('missing-credential');
    const serialized = JSON.stringify(body);
    // Do not race a durable preparation hook: it must settle before the caller
    // can safely mark a request unsent or release its asset lock.
    if (send?.before) await send.before();
    authorize(context);
    const controller = new AbortController();
    const expiresAt = Math.min(context.deadlineAt, Date.now() + c.timeoutMs);
    let timedOut = false;
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); },
      Math.max(0, expiresAt - Date.now()));
    const abortCode = (): SearchProviderErrorCode => context.signal.aborted ? 'aborted' : timedOut ? 'timeout' : 'provider-error';
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new SearchProviderError(abortCode()));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    // Covers cancellation during synchronous setup as well as fetch implementations ignoring signals.
    if (context.signal.aborted) controller.abort();
    const operation = async (): Promise<Record<string, unknown>> => {
      authorize(context);
      if (controller.signal.aborted) return fail(abortCode());
      send?.invoked?.();
      const response = await (options.fetch ?? globalThis.fetch)(`${c.baseUrl}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'x-tdai-service-id': c.serviceId,
          'Content-Type': 'application/json' }, body: serialized,
        redirect: 'error', signal: controller.signal,
      });
      const rejectResponse = (code: SearchProviderErrorCode): never => {
        // Do not leave a rejected/oversized body downloading, even with injected fetch.
        if (response.body) void response.body.cancel().catch(() => undefined);
        return fail(code);
      };
      if (controller.signal.aborted) return rejectResponse(abortCode());
      if (response.redirected || response.status < 200 || response.status >= 300) return rejectResponse('remote-http-error');
      const length = response.headers.get('content-length');
      if (length !== null) {
        if (!/^[0-9]+$/.test(length)) return rejectResponse('remote-response-invalid');
        if (Number(length) > MAX_RESPONSE_BYTES) return rejectResponse('response-too-large');
      }
      if (!response.body) return fail('remote-response-invalid');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancelReader = () => { void reader.cancel().catch(() => undefined); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        while (true) {
          const part = await reader.read();
          if (controller.signal.aborted) return fail(abortCode());
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) return fail('response-too-large');
          chunks.push(part.value);
        }
      } finally {
        controller.signal.removeEventListener('abort', cancelReader);
        if (size > MAX_RESPONSE_BYTES) cancelReader();
        reader.releaseLock();
      }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return fail('remote-response-invalid'); }
      if (!object(parsed) || typeof parsed.code !== 'number') return fail('remote-response-invalid');
      if (parsed.code !== 0) return fail('provider-error');
      if (!object(parsed.data)) return fail('remote-response-invalid');
      if (Date.now() >= expiresAt) return fail('timeout');
      return parsed.data;
    };
    try { return await Promise.race([operation(), cancelled]); }
    catch (error) {
      if (controller.signal.aborted) return fail(abortCode());
      if (error instanceof SearchProviderError) throw error;
      return fail('provider-error');
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
  }

  return { authorize, post };
}

/** Queries are exported to the configured upstream, which may log telemetry despite read-only tools. */
export function createTencentProvider(
  config: TencentProviderConfig,
  options: { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv } = {},
): SearchProvider {
  const c = validateTencentProviderConfig(config);
  const namespace = tencentProviderNamespace(c);
  const atomic = c.kind === 'tencent-atomic';
  const capabilities = { modes: atomic ? ['auto'] as const : ['auto', 'lexical'] as const,
    filters: [] as const, maxCandidates: 100, read: !atomic };
  const { authorize, post } = createTencentTransport(c, options);
  const provider: SearchProvider = {
    id: c.id, namespace, external: true, capabilities,
    async search(request) {
      authorize(request);
      if (request.mode !== 'auto' && (atomic || request.mode !== 'lexical')) return fail('unsupported-mode');
      if (!object(request.filters)) return fail('invalid-request');
      if (Object.keys(request.filters).length) return fail('unsupported-filter');
      if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 2048 ||
          !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
          !Number.isInteger(request.candidateLimit) || request.candidateLimit < 1 || request.candidateLimit > 100) return fail('invalid-request');
      const data = await post(atomic ? '/v3/atomic/search' : '/v3/tools/call', atomic ? {
        query: request.query, limit: request.candidateLimit, team_id: c.teamId,
        user_id: c.userId, agent_id: c.agentId, ...(c.taskId ? { task_id: c.taskId } : {}),
      } : { knowledge_id: c.knowledgeId, tool_name: 'search',
        params: { query: request.query, limit: request.candidateLimit } }, request);
      const items = atomic ? data.items : data.results;
      if (!Array.isArray(items) || items.length > 100 || items.length > request.candidateLimit) return fail('remote-response-invalid');
      if (!atomic && data.count !== undefined &&
          (typeof data.count !== 'number' || !Number.isSafeInteger(data.count) || data.count < items.length)) return fail('remote-response-invalid');
      const hits: SearchCandidate[] = items.map(item => {
        if (!object(item)) return fail('remote-response-invalid');
        if (atomic) {
          if (item.team_id !== c.teamId || item.user_id !== c.userId || item.agent_id !== c.agentId ||
              (c.taskId !== undefined && item.task_id !== c.taskId)) return fail('scope-mismatch');
          const recordId = string(item.id, 256);
          const type = string(item.type, 256);
          const content = string(item.content, 128 * 1024, true);
          if (item.background !== undefined) string(item.background, 128 * 1024, true);
          let version: string;
          if (typeof item.version === 'number' && Number.isSafeInteger(item.version) && item.version >= 0) version = String(item.version);
          else version = string(item.version, 256);
          return { ref: { providerId: c.id, namespace, recordId, version }, kind: 'memory',
            title: type, snippet: content.slice(0, 4096), trust: 'external', rawScore: score(item.score) };
        }
        if (!safePath(item.path)) return fail('remote-response-invalid');
        return { ref: { providerId: c.id, namespace, recordId: item.path }, kind: 'document',
          title: string(item.title, 512, true), snippet: string(item.snippet, 64 * 1024, true).slice(0, 4096),
          trust: 'external', rawScore: score(item.score) };
      });
      return atomic ? { hits, complete: false, warnings: ['upstream-filtered-candidates'] } :
        { hits, complete: hits.length < request.candidateLimit && data.count === hits.length };
    },
  };
  if (!atomic) provider.resolver = {
    async read(ref: SearchReference, context) {
      authorize(context);
      if (!ref || ref.providerId !== c.id || ref.namespace !== namespace) return fail('scope-mismatch');
      if (!safePath(ref.recordId) || (ref.version !== undefined &&
          (typeof ref.version !== 'string' || !ref.version.length || ref.version.length > 256))) return fail('invalid-request');
      const data = await post('/v3/tools/call', { knowledge_id: c.knowledgeId,
        tool_name: 'read_page', params: { refs: [ref.recordId] } }, context);
      if (!Array.isArray(data.items) || data.items.length !== 1 || !object(data.items[0])) return fail('remote-response-invalid');
      const item = data.items[0];
      if (item.ref !== ref.recordId) return fail('scope-mismatch');
      if (item.not_found === true) return fail('not-found');
      if (item.not_found !== undefined && item.not_found !== false) return fail('remote-response-invalid');
      const content = string(item.content, MAX_CONTENT_CHARS, true);
      const version = createHash('sha256').update(content).digest('hex');
      if (ref.version !== undefined && ref.version !== version) return fail('stale-reference');
      return { ref: { providerId: c.id, namespace, recordId: ref.recordId, version }, content, trust: 'external' };
    },
  };
  return provider;
}
