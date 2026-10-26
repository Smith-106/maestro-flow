import { createHash } from 'node:crypto';
import {
  SearchProviderError, SEARCH_PROVIDER_MAX_PROVIDERS,
  type ProviderSearchRequest, type ProviderSearchResult, type ProviderSearchFilters,
  type SearchMode, type SearchReference, type ResolvedSearchSource,
} from '../../../shared/search-provider.js';
import { resolveRepositoryContext, type RepositoryContext } from '../../repository/context.js';
import { createLocalSearchProvider, type LocalSearchItem } from './local.js';
import { runSearchGateway, readSearchSource } from './gateway.js';

export interface ResolvedProviderScope {
  current: RepositoryContext;
  target: RepositoryContext;
  authority: { repoId: string | null; workspaceFence: string };
}
export interface ConfiguredSearchContext {
  projectRoot: string;
  repo?: string;
  executionMode?: 'default' | 'read-only-probe';
  signal?: AbortSignal;
  timeoutMs?: number;
  localSearch?: (request: ProviderSearchRequest, scope: ResolvedProviderScope) => Promise<readonly LocalSearchItem[] | ProviderSearchResult>;
  localRead?: (ref: SearchReference, scope: ResolvedProviderScope,
    context: Pick<ProviderSearchRequest, 'authority' | 'signal' | 'deadlineAt' | 'executionMode'>) => Promise<ResolvedSearchSource>;
}
export interface ConfiguredSearchInput extends ConfiguredSearchContext {
  query: string;
  providerIds?: readonly string[];
  limit?: number;
  candidateLimit?: number;
  mode?: SearchMode;
  filters?: ProviderSearchFilters;
}
export interface SearchRuntimeDependencies { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv }

/** Explicit selection only. There is deliberately no 'all configured' expansion. */
export function parseProviderSelection(value: unknown): string[] {
  if (value === undefined) return ['local'];
  const parts: unknown = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(parts) || !parts.length || parts.length > SEARCH_PROVIDER_MAX_PROVIDERS) throw new SearchProviderError('invalid-request');
  const ids = parts.map(part => {
    if (typeof part !== 'string') throw new SearchProviderError('invalid-request');
    const id = part.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new SearchProviderError('invalid-request');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new SearchProviderError('invalid-request');
  return ids;
}
export function resolveProviderScope(projectRoot: string, repo?: string): ResolvedProviderScope {
  try {
    const current = resolveRepositoryContext('current', { projectRoot });
    const target = repo ? resolveRepositoryContext(repo, { projectRoot: current.projectRoot }) : current;
    return { current, target, authority: { repoId: target.repoId,
      workspaceFence: target.repoId ? `repo:${target.repoId}` : `legacy:${createHash('sha256').update(target.workflowRoot).digest('hex')}` } };
  } catch { throw new SearchProviderError('scope-mismatch'); }
}
function deadline(input: ConfiguredSearchContext): number {
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new SearchProviderError('invalid-request');
  return Date.now() + timeoutMs;
}
async function providersFor(
  ids: string[], input: ConfiguredSearchContext, scope: ResolvedProviderScope, dependencies: SearchRuntimeDependencies,
) {
  const remoteIds = ids.filter(id => id !== 'local');
  if (input.executionMode !== undefined && input.executionMode !== 'default' && input.executionMode !== 'read-only-probe') {
    throw new SearchProviderError('invalid-request');
  }
  if (input.signal?.aborted) throw new SearchProviderError('aborted');
  // Before config imports, disk reads or credential lookup: a probe is hermetic.
  if (input.executionMode === 'read-only-probe' && remoteIds.length) throw new SearchProviderError('probe-forbidden');
  if (remoteIds.length && (!scope.target.repoId || scope.target.relation !== 'current')) throw new SearchProviderError('scope-mismatch');
  const configs = remoteIds.length
    ? (await import('./config.js')).loadSearchProviderConfigs(scope.current.workflowRoot)
    : [];
  const selected = remoteIds.map(id => {
    const config = configs.find(candidate => candidate.id === id);
    if (!config) throw new SearchProviderError('unknown-provider');
    if (!config.enabled) throw new SearchProviderError('disabled-provider');
    if (config.repoId !== scope.target.repoId) throw new SearchProviderError('scope-mismatch');
    return config;
  });
  const external = selected.length ? await import('./tencent.js') : undefined;
  return ids.map(id => {
    if (id === 'local') {
      return createLocalSearchProvider({ namespace: scope.authority.workspaceFence,
        search: async request => {
          if (!input.localSearch) throw new SearchProviderError('provider-error');
          return input.localSearch(request, scope);
        },
        ...(input.localRead ? { read: (ref: SearchReference, context: Pick<ProviderSearchRequest, 'authority' | 'signal' | 'deadlineAt' | 'executionMode'>) => input.localRead!(ref, scope, context) } : {}),
      });
    }
    return external!.createTencentProvider(selected.find(config => config.id === id)!, dependencies);
  });
}

export async function runConfiguredSearch(input: ConfiguredSearchInput, dependencies: SearchRuntimeDependencies = {}) {
  const ids = parseProviderSelection(input.providerIds);
  const deadlineAt = deadline(input);
  const scope = resolveProviderScope(input.projectRoot, input.repo);
  const providers = await providersFor(ids, input, scope, dependencies);
  return runSearchGateway({ query: input.query, providers, authority: scope.authority, limit: input.limit,
    candidateLimit: input.candidateLimit, mode: input.mode, filters: input.filters,
    signal: input.signal, deadlineAt, executionMode: input.executionMode });
}

export async function readConfiguredSource(
  input: ConfiguredSearchContext & { ref: SearchReference }, dependencies: SearchRuntimeDependencies = {},
): Promise<ResolvedSearchSource> {
  if (!input.ref || typeof input.ref !== 'object') throw new SearchProviderError('invalid-request');
  const ids = parseProviderSelection([input.ref.providerId]);
  const deadlineAt = deadline(input);
  const scope = resolveProviderScope(input.projectRoot, input.repo);
  const providers = await providersFor(ids, input, scope, dependencies);
  return readSearchSource(providers[0], input.ref, { authority: scope.authority,
    signal: input.signal ?? new AbortController().signal, deadlineAt, executionMode: input.executionMode ?? 'default' });
}
