/** Public read-only search ports. No engine, filesystem, model or transport imports. */
export const SEARCH_PROVIDER_SCHEMA = 'maestro-search/1.0' as const;
export const SEARCH_PROVIDER_MAX_CANDIDATES = 500;
export const SEARCH_PROVIDER_MAX_QUERY_CHARS = 2048;
export const SEARCH_PROVIDER_MAX_PROVIDERS = 8;
export const SEARCH_PROVIDER_MAX_SOURCE_CHARS = 262_144;

export type SearchMode = 'auto' | 'lexical' | 'semantic' | 'hybrid';
export interface SearchAuthority {
  /** Host-resolved target identity, never a tenant ID supplied by a remote hit. */
  repoId: string | null;
  workspaceFence: string;
}
export interface ProviderSearchFilters {
  type?: string;
  category?: string;
  tag?: string;
  keyword?: string;
  workspace?: string;
  includeDeprecated?: boolean;
}
export interface SearchReference {
  providerId: string;
  /** Changes when the endpoint, tenant, resource or repository binding changes. */
  namespace: string;
  recordId: string;
  version?: string;
}
export interface SearchCandidate {
  ref: SearchReference;
  kind: 'knowledge' | 'code' | 'memory' | 'document';
  title: string;
  snippet: string;
  trust: 'local' | 'external';
  /** External assets and built-in templates are references, not current-project authority. */
  referenceOnly?: boolean;
  /** Provider-specific score; only ranks, not these magnitudes, are fused. */
  rawScore?: { value: number; metric: string };
  source?: { path?: string; sourceRef?: string; workspaceFence?: string };
}
export interface ProviderSearchRequest {
  query: string;
  limit: number;
  candidateLimit: number;
  mode: SearchMode;
  filters: ProviderSearchFilters;
  authority: SearchAuthority;
  deadlineAt: number;
  signal: AbortSignal;
  executionMode: 'default' | 'read-only-probe';
}
export interface ProviderSearchResult {
  hits: readonly SearchCandidate[];
  /** False when upstream truncation/filtering cannot guarantee requested coverage. */
  complete: boolean;
  warnings?: readonly string[];
}
export interface ProviderCapabilities {
  modes: readonly SearchMode[];
  filters: readonly (keyof ProviderSearchFilters)[];
  maxCandidates: number;
  read: boolean;
}
export interface ResolvedSearchSource {
  ref: SearchReference;
  content: string;
  trust: 'local' | 'external';
}
export interface SourceResolver {
  read(ref: SearchReference, context: Pick<ProviderSearchRequest, 'authority' | 'signal' | 'deadlineAt' | 'executionMode'>): Promise<ResolvedSearchSource>;
}
export interface SearchProvider {
  id: string;
  namespace: string;
  external: boolean;
  capabilities: ProviderCapabilities;
  search(request: ProviderSearchRequest): Promise<ProviderSearchResult>;
  resolver?: SourceResolver;
}
export const SEARCH_PROVIDER_ERROR_CODES = [
  'invalid-request', 'invalid-config', 'unknown-provider', 'disabled-provider',
  'missing-credential', 'scope-mismatch', 'unsupported-mode', 'unsupported-filter',
  'read-unsupported', 'probe-forbidden', 'aborted', 'timeout', 'provider-error',
  'remote-http-error', 'remote-response-invalid', 'response-too-large', 'not-found', 'stale-reference',
] as const;
export type SearchProviderErrorCode = typeof SEARCH_PROVIDER_ERROR_CODES[number];
export class SearchProviderError extends Error {
  constructor(readonly code: SearchProviderErrorCode) {
    // Deliberately no remote messages, endpoint URLs, request bodies or credentials.
    super(code);
    this.name = 'SearchProviderError';
  }
}
export interface ProviderSearchStatus {
  id: string;
  namespace: string;
  status: 'ok' | 'degraded' | 'error';
  durationMs: number;
  code?: SearchProviderErrorCode;
  warnings?: readonly string[];
}
export interface UnifiedSearchResponse {
  schemaVersion: typeof SEARCH_PROVIDER_SCHEMA;
  query: string;
  results: Array<SearchCandidate & { rank: number; fusionScore: number }>;
  providers: ProviderSearchStatus[];
  complete: boolean;
  /** Retrieval never authorizes knowledge promotion, source writes or workflow resume. */
  mutationAuthorized: false;
}
