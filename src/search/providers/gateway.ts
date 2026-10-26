import {
  SEARCH_PROVIDER_SCHEMA, SEARCH_PROVIDER_MAX_CANDIDATES, SEARCH_PROVIDER_MAX_PROVIDERS, SEARCH_PROVIDER_ERROR_CODES, SEARCH_PROVIDER_MAX_SOURCE_CHARS,
  SEARCH_PROVIDER_MAX_QUERY_CHARS, SearchProviderError,
  type SearchAuthority, type SearchCandidate, type SearchMode, type SearchProvider,
  type SearchProviderErrorCode, type ProviderSearchFilters, type ProviderSearchRequest,
  type ProviderSearchStatus, type SearchReference, type ResolvedSearchSource, type UnifiedSearchResponse,
} from '../../../shared/search-provider.js';

export interface SearchGatewayInput {
  query: string;
  providers: readonly SearchProvider[];
  authority: SearchAuthority;
  limit?: number;
  candidateLimit?: number;
  mode?: SearchMode;
  filters?: ProviderSearchFilters;
  deadlineAt?: number;
  signal?: AbortSignal;
  executionMode?: 'default' | 'read-only-probe';
}

function invalid(): never { throw new SearchProviderError('invalid-request'); }
function boundedInteger(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) invalid();
  return value;
}
function token(value: unknown, max = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0');
}
function validateAuthority(authority: SearchAuthority): void {
  if (!authority || !text(authority.workspaceFence, 256) || !authority.workspaceFence
    || !(authority.repoId === null || (text(authority.repoId, 128) && authority.repoId))) invalid();
}
function validateFilters(filters: ProviderSearchFilters): void {
  const supported = ['type', 'category', 'tag', 'keyword', 'workspace', 'includeDeprecated'];
  for (const [key, value] of Object.entries(filters)) {
    if (!supported.includes(key)) invalid();
    if (value === undefined) continue;
    if (key === 'includeDeprecated' ? typeof value !== 'boolean' : !text(value, 256)) invalid();
  }
}
export function searchProviderErrorCode(error: unknown): SearchProviderErrorCode {
  return error instanceof SearchProviderError && SEARCH_PROVIDER_ERROR_CODES.includes(error.code) ? error.code : 'provider-error';
}
function abortError(signal: AbortSignal): SearchProviderError {
  return signal.reason instanceof SearchProviderError ? signal.reason : new SearchProviderError('aborted');
}

/** Also bounds plugins that ignore cancellation; the losing promise stays observed. */
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortError(signal);
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function validateProvider(provider: SearchProvider): void {
  if (!token(provider.id, 128) || !text(provider.namespace, 256) || !provider.namespace
    || typeof provider.external !== 'boolean' || !provider.capabilities
    || !Array.isArray(provider.capabilities.modes) || !Array.isArray(provider.capabilities.filters)) invalid();
  boundedInteger(provider.capabilities.maxCandidates, SEARCH_PROVIDER_MAX_CANDIDATES);
}
function validateCandidate(hit: SearchCandidate, provider: SearchProvider): void {
  if (!hit || !hit.ref || hit.ref.providerId !== provider.id || hit.ref.namespace !== provider.namespace
    || !text(hit.ref.recordId, 2048) || !hit.ref.recordId
    || (hit.ref.version !== undefined && !text(hit.ref.version, 256))
    || !['knowledge', 'code', 'memory', 'document'].includes(hit.kind)
    || hit.trust !== (provider.external ? 'external' : 'local')
    || (hit.referenceOnly !== undefined && typeof hit.referenceOnly !== 'boolean')
    || !text(hit.title, 512) || !text(hit.snippet, 4096)
    || (hit.rawScore !== undefined && (!Number.isFinite(hit.rawScore.value) || !token(hit.rawScore.metric)))
    || (hit.source !== undefined && (!hit.source || Object.values(hit.source).some(value => value !== undefined && !text(value, 2048))))) {
    throw new SearchProviderError('remote-response-invalid');
  }
}

/** Rank fusion is namespace-preserving; external claims never become canonical IDs. */
export async function runSearchGateway(input: SearchGatewayInput): Promise<UnifiedSearchResponse> {
  if (!input || !text(input.query, SEARCH_PROVIDER_MAX_QUERY_CHARS) || !input.query.trim()
    || !Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > SEARCH_PROVIDER_MAX_PROVIDERS) invalid();
  const providers: readonly SearchProvider[] = input.providers;
  validateAuthority(input.authority);
  const limit = boundedInteger(input.limit ?? 20, SEARCH_PROVIDER_MAX_CANDIDATES);
  const candidateLimit = boundedInteger(input.candidateLimit ?? Math.min(500, Math.max(40, limit * 2)), 500);
  validateFilters(input.filters ?? {});
  const filters: ProviderSearchFilters = Object.fromEntries(Object.entries(input.filters ?? {})
    .filter(([, value]) => value !== undefined && value !== false));
  const mode = input.mode ?? 'auto';
  if (!['auto', 'lexical', 'semantic', 'hybrid'].includes(mode)) invalid();
  const executionMode = input.executionMode ?? 'default';
  if (!['default', 'read-only-probe'].includes(executionMode)) invalid();
  const ids = new Set<string>();
  for (const provider of providers) {
    validateProvider(provider);
    if (ids.has(provider.id)) invalid();
    ids.add(provider.id);
    if (executionMode === 'read-only-probe' && provider.external) throw new SearchProviderError('probe-forbidden');
  }
  const deadlineAt = input.deadlineAt ?? Date.now() + 10_000;
  if (!Number.isFinite(deadlineAt) || deadlineAt > Date.now() + 30_000) invalid();
  if (deadlineAt <= Date.now()) throw new SearchProviderError('timeout');
  if (input.signal?.aborted) throw new SearchProviderError('aborted');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new SearchProviderError('timeout')), Math.max(0, deadlineAt - Date.now()));
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  try {
    const passes = await Promise.all(providers.map(async provider => {
      const startedAt = performance.now();
      const status: ProviderSearchStatus = { id: provider.id, namespace: provider.namespace, status: 'ok', durationMs: 0 };
      try {
        if (!provider.capabilities.modes.includes(mode)) throw new SearchProviderError('unsupported-mode');
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && value !== false && !provider.capabilities.filters.includes(key as keyof ProviderSearchFilters)) {
            throw new SearchProviderError('unsupported-filter');
          }
        }
        const request: ProviderSearchRequest = { query: input.query, limit: Math.min(limit, provider.capabilities.maxCandidates),
          candidateLimit: Math.min(candidateLimit, provider.capabilities.maxCandidates), mode, filters: Object.freeze({ ...filters }),
          authority: Object.freeze({ ...input.authority }), deadlineAt, signal, executionMode };
        const result = await abortable(() => provider.search(request), signal);
        if (!result || typeof result.complete !== 'boolean' || !Array.isArray(result.hits)
          || result.hits.length > request.candidateLimit) throw new SearchProviderError('remote-response-invalid');
        for (const hit of result.hits) validateCandidate(hit, provider);
        if (!result.complete) status.status = 'degraded';
        if (result.warnings?.length) status.warnings = result.warnings.slice(0, 8).map(w => token(w) ? w : 'provider-warning');
        return { status, hits: result.hits };
      } catch (error) {
        status.status = 'error';
        status.code = searchProviderErrorCode(error);
        return { status, hits: [] as SearchCandidate[] };
      } finally {
        status.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      }
    }));
    if (input.signal?.aborted) throw new SearchProviderError('aborted');
    const seen = new Set<string>();
    const ranked: Array<SearchCandidate & { rank: number; fusionScore: number; providerOrder: number }> = [];
    for (let providerOrder = 0; providerOrder < passes.length; providerOrder++) {
      const hits = passes[providerOrder].hits;
      let uniqueRank = 0;
      for (const hit of hits) {
        const identity = JSON.stringify([hit.ref.providerId, hit.ref.namespace, hit.ref.recordId]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        uniqueRank++;
        // Copy the public whitelist, not arbitrary provider fields/authority claims.
        ranked.push({ ref: { providerId: hit.ref.providerId, namespace: hit.ref.namespace, recordId: hit.ref.recordId,
          ...(hit.ref.version !== undefined ? { version: hit.ref.version } : {}) },
          kind: hit.kind, title: hit.title, snippet: hit.snippet, trust: hit.trust,
          ...(input.providers[providerOrder].external || hit.referenceOnly ? { referenceOnly: true } : {}),
          ...(hit.rawScore ? { rawScore: { value: hit.rawScore.value, metric: hit.rawScore.metric } } : {}),
          ...(hit.source ? { source: { ...(hit.source.path !== undefined ? { path: hit.source.path } : {}),
            ...(hit.source.sourceRef !== undefined ? { sourceRef: hit.source.sourceRef } : {}),
            ...(hit.source.workspaceFence !== undefined ? { workspaceFence: hit.source.workspaceFence } : {}) } } : {}),
          rank: uniqueRank, fusionScore: 1 / (60 + uniqueRank), providerOrder });
      }
    }
    ranked.sort((a, b) => b.fusionScore - a.fusionScore || a.providerOrder - b.providerOrder || a.ref.recordId.localeCompare(b.ref.recordId));
    return { schemaVersion: SEARCH_PROVIDER_SCHEMA, query: input.query,
      results: ranked.slice(0, limit).map(({ providerOrder: _order, ...hit }, position) => ({ ...hit, rank: position + 1 })),
      providers: passes.map(p => p.status), complete: passes.every(p => p.status.status === 'ok'), mutationAuthorized: false };
  } finally { clearTimeout(timer); }
}

export async function readSearchSource(
  provider: SearchProvider, ref: SearchReference,
  context: Pick<ProviderSearchRequest, 'authority' | 'signal' | 'deadlineAt' | 'executionMode'>,
): Promise<ResolvedSearchSource> {
  validateProvider(provider);
  validateAuthority(context.authority);
  if (!ref || ref.providerId !== provider.id || ref.namespace !== provider.namespace || !text(ref.recordId, 2048) || !ref.recordId
    || (ref.version !== undefined && !text(ref.version, 256))) throw new SearchProviderError('stale-reference');
  if (context.executionMode === 'read-only-probe' && provider.external) throw new SearchProviderError('probe-forbidden');
  if (!provider.capabilities.read || !provider.resolver) throw new SearchProviderError('read-unsupported');
  if (!Number.isFinite(context.deadlineAt) || context.deadlineAt > Date.now() + 30_000) invalid();
  if (context.deadlineAt <= Date.now()) throw new SearchProviderError('timeout');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new SearchProviderError('timeout')), context.deadlineAt - Date.now());
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  try {
    const result = await abortable(() => provider.resolver!.read(ref, { ...context, signal }), signal);
    if (!result || !result.ref || result.ref.providerId !== ref.providerId || result.ref.namespace !== ref.namespace
      || result.ref.recordId !== ref.recordId || (result.ref.version !== undefined && !text(result.ref.version, 256))
      || result.trust !== (provider.external ? 'external' : 'local')
      || !text(result.content, SEARCH_PROVIDER_MAX_SOURCE_CHARS)) throw new SearchProviderError('remote-response-invalid');
    if (ref.version !== undefined && result.ref.version !== ref.version) throw new SearchProviderError('stale-reference');
    return { ref: { providerId: result.ref.providerId, namespace: result.ref.namespace, recordId: result.ref.recordId,
      ...(result.ref.version !== undefined ? { version: result.ref.version } : {}) }, content: result.content, trust: result.trust };
  } catch (error) { throw new SearchProviderError(searchProviderErrorCode(error)); }
  finally { clearTimeout(timer); }
}
