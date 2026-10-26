import type { Hono } from 'hono';
import { dirname } from 'node:path';
import { SearchProviderError, type ProviderSearchFilters, type SearchMode, type SearchReference } from '../../../../shared/search-provider.js';
import type { WikiIndexer } from '../wiki/wiki-indexer.js';
import type { WikiSearchFilters } from '../wiki/wiki-types.js';
import type { ConfiguredSearchContext } from '../../../../src/search/providers/runtime.js';

interface Context { workflowRoot: string; indexer: WikiIndexer }
function invalid(): never { throw new SearchProviderError('invalid-request'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 16_384)) invalid();
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let onAbort!: () => void;
  // Body controls cannot bound a stalled stream before the JSON is available.
  const deadline = AbortSignal.timeout(5_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SearchProviderError(request.signal.aborted ? 'aborted' : 'timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const part = await Promise.race([stopped, reader.read()]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16_384) invalid();
      parts.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
  catch { invalid(); }
  if (!object(body)) invalid();
  return body;
}
function common(body: Record<string, unknown>) {
  if (body.repo !== undefined && (typeof body.repo !== 'string' || !body.repo || body.repo.length > 256)) invalid();
  if (body.readOnlyProbe !== undefined && typeof body.readOnlyProbe !== 'boolean') invalid();
  if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== 'number' || !Number.isInteger(body.timeoutMs)
    || body.timeoutMs < 1 || body.timeoutMs > 30_000)) invalid();
  return { repo: body.repo as string | undefined, timeoutMs: body.timeoutMs as number | undefined,
    executionMode: body.readOnlyProbe === true ? 'read-only-probe' as const : 'default' as const };
}
function status(code: string): 400 | 403 | 404 | 408 | 409 | 502 {
  if (code === 'scope-mismatch' || code === 'probe-forbidden' || code === 'disabled-provider') return 403;
  if (code === 'unknown-provider' || code === 'not-found') return 404;
  if (code === 'stale-reference') return 409;
  if (code === 'aborted' || code === 'timeout') return 408;
  if (code === 'invalid-request' || code === 'invalid-config' || code.startsWith('unsupported-') || code === 'read-unsupported') return 400;
  return 502;
}

/** Explicit new API; GET /api/wiki and its existing response models stay unchanged. */
export function registerSearchProviderRoutes<T extends Context>(
  app: Hono, getContext: () => T, isCurrent: (context: T) => boolean,
): void {
  app.post('/api/wiki/search', async c => {
    const context = getContext();
    try {
      const body = await readBody(c.req.raw);
      if (Object.keys(body).some(key => !['query', 'providers', 'repo', 'limit', 'mode', 'filters', 'readOnlyProbe', 'timeoutMs'].includes(key))) invalid();
      if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 2048) invalid();
      if (body.providers !== undefined && (!Array.isArray(body.providers) || !body.providers.every(id => typeof id === 'string'))) invalid();
      if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 500)) invalid();
      if (body.mode !== undefined && !['auto', 'lexical', 'semantic', 'hybrid'].includes(String(body.mode))) invalid();
      if (body.filters !== undefined && !object(body.filters)) invalid();
      const controls = common(body);
      const { runConfiguredSearch } = await import('../../../../src/search/providers/runtime.js');
      const localSearch: ConfiguredSearchContext['localSearch'] = async (request, scope) => {
        if (!isCurrent(context)) throw new SearchProviderError('scope-mismatch');
        if (request.filters.type && !['project', 'roadmap', 'spec', 'issue', 'knowhow', 'note', 'domain', 'session', 'scratch'].includes(request.filters.type)) {
          throw new SearchProviderError('unsupported-filter');
        }
        // A probe must not reuse a filesystem reader or its session scan policy.
        const hermetic = request.executionMode === 'read-only-probe'
          ? new (await import('../wiki/wiki-indexer.js')).WikiIndexer({ workflowRoot: context.workflowRoot, role: 'hermetic', includeCliSessions: false })
          : null;
        const indexer = hermetic ?? context.indexer;
        try {
          const result = await indexer.searchWithMeta(request.query, request.candidateLimit, {
            skipEmbedding: request.mode === 'auto' || request.mode === 'lexical', signal: request.signal,
            filters: { ...request.filters, type: request.filters.type as WikiSearchFilters['type'], applicableRepoId: scope.target.repoId ?? '__legacy__',
              ...(controls.repo && scope.target.repoId ? { repoId: scope.target.repoId } : {}),
              ...(controls.repo && !scope.target.repoId ? { repoAlias: scope.target.alias } : {}) },
          });
          return result.results.map(({ entry, score }) => ({ id: entry.id, title: entry.title, summary: entry.summary, score,
            sourceRef: entry.sourceRef, path: entry.source.path, workspaceFence: entry.workspaceFence ?? entry.source.workspaceFence }));
        } finally { await hermetic?.close(); }
      };
      const result = await runConfiguredSearch({ projectRoot: dirname(context.workflowRoot), query: body.query,
        providerIds: body.providers as string[] | undefined, limit: body.limit as number | undefined,
        mode: body.mode as SearchMode | undefined, filters: body.filters as ProviderSearchFilters | undefined,
        ...controls, signal: c.req.raw.signal, localSearch });
      if (!isCurrent(context)) throw new SearchProviderError('scope-mismatch');
      return c.json(result, result.providers.every(provider => provider.status === 'error') ? 502 : 200);
    } catch (error) {
      const code = error instanceof SearchProviderError ? error.code : 'provider-error';
      return c.json({ error: code, mutationAuthorized: false }, status(code));
    }
  });

  app.post('/api/wiki/search/read', async c => {
    const context = getContext();
    try {
      const body = await readBody(c.req.raw);
      if (Object.keys(body).some(key => !['ref', 'repo', 'readOnlyProbe', 'timeoutMs'].includes(key))) invalid();
      if (!object(body.ref) || Object.keys(body.ref).some(key => !['providerId', 'namespace', 'recordId', 'version'].includes(key))
        || !['providerId', 'namespace', 'recordId'].every(key => typeof (body.ref as Record<string, unknown>)[key] === 'string')
        || (body.ref.version !== undefined && typeof body.ref.version !== 'string')) invalid();
      const controls = common(body);
      const { readConfiguredSource } = await import('../../../../src/search/providers/runtime.js');
      const result = await readConfiguredSource({ projectRoot: dirname(context.workflowRoot),
        ref: body.ref as unknown as SearchReference, ...controls, signal: c.req.raw.signal });
      if (!isCurrent(context)) throw new SearchProviderError('scope-mismatch');
      return c.json({ ...result, mutationAuthorized: false });
    } catch (error) {
      const code = error instanceof SearchProviderError ? error.code : 'provider-error';
      return c.json({ error: code, mutationAuthorized: false }, status(code));
    }
  });
}
