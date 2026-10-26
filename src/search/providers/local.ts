import type {
  SearchCandidate, SearchProvider, ProviderSearchRequest, ProviderSearchResult,
  ResolvedSearchSource, SearchReference,
} from '../../../shared/search-provider.js';

export interface LocalSearchItem {
  id: string;
  title: string;
  kind?: SearchCandidate['kind'];
  snippet?: string | null;
  summary?: string | null;
  score?: number | null;
  sourceRef?: string | null;
  path?: string;
  workspaceFence?: string;
  referenceOnly?: boolean;
}
export function localSearchCandidate(namespace: string, item: LocalSearchItem): SearchCandidate {
  return { ref: { providerId: 'local', namespace, recordId: item.id }, kind: item.kind ?? 'knowledge',
    title: item.title.slice(0, 512), snippet: (item.snippet ?? item.summary ?? '').slice(0, 4096), trust: 'local',
    ...(item.referenceOnly ? { referenceOnly: true } : {}),
    ...(typeof item.score === 'number' && Number.isFinite(item.score) ? { rawScore: { value: item.score, metric: 'local-score' } } : {}),
    source: { ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}), ...(item.path ? { path: item.path } : {}),
      ...(item.workspaceFence ? { workspaceFence: item.workspaceFence } : {}) } };
}

/** Engines stay behind callbacks: importing the port never initializes ONNX or a daemon. */
export function createLocalSearchProvider(options: {
  namespace: string;
  search: (request: ProviderSearchRequest) => Promise<readonly LocalSearchItem[] | ProviderSearchResult>;
  read?: (ref: SearchReference, context: Parameters<NonNullable<SearchProvider['resolver']>['read']>[1]) => Promise<ResolvedSearchSource>;
}): SearchProvider {
  return { id: 'local', namespace: options.namespace, external: false,
    capabilities: { modes: ['auto', 'lexical', 'hybrid'],
      filters: ['type', 'category', 'tag', 'keyword', 'workspace', 'includeDeprecated'], maxCandidates: 500, read: Boolean(options.read) },
    async search(request) {
      const result = await options.search(request);
      return Array.isArray(result)
        ? { hits: result.map(item => localSearchCandidate(options.namespace, item)), complete: true }
        : result as ProviderSearchResult;
    },
    ...(options.read ? { resolver: { read: options.read } } : {}),
  };
}
