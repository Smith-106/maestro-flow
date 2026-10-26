import { SearchProviderError, type ProviderSearchFilters, type UnifiedSearchResponse } from '../../../shared/search-provider.js';
import type { CcwToolResult } from '../../types/tool-schema.js';
import { providerWikiItem } from './cli.js';
import { searchProviderErrorCode } from './gateway.js';
import { parseProviderSelection, runConfiguredSearch } from './runtime.js';

/** Explicit selection only; projectRoot is supplied by the host, never by tool parameters. */
export async function runProviderMcp(params: Record<string, unknown>, projectRoot: string): Promise<CcwToolResult<UnifiedSearchResponse>> {
  try {
    if (Object.keys(params).some(key => !['query', 'providers', 'repo', 'limit', 'semantic', 'skipEmbedding',
      'readOnlyProbe', 'executionMode', 'type', 'category', 'tag', 'keyword', 'workspace', 'includeDeprecated'].includes(key))
      || typeof params.query !== 'string' || !Array.isArray(params.providers)
      || (params.repo !== undefined && typeof params.repo !== 'string')
      || (params.limit !== undefined && typeof params.limit !== 'number')
      || (params.semantic !== undefined && typeof params.semantic !== 'boolean')
      || (params.skipEmbedding !== undefined && typeof params.skipEmbedding !== 'boolean')
      || (params.semantic === true && params.skipEmbedding === true)
      || (params.readOnlyProbe !== undefined && typeof params.readOnlyProbe !== 'boolean')
      || (params.executionMode !== undefined && params.executionMode !== 'default' && params.executionMode !== 'read-only-probe')) {
      throw new SearchProviderError('invalid-request');
    }
    const filters: ProviderSearchFilters = {};
    for (const key of ['type', 'category', 'tag', 'keyword', 'workspace', 'includeDeprecated'] as const) {
      const value = params[key];
      if (value === undefined) continue;
      if (key === 'includeDeprecated') {
        if (typeof value !== 'boolean') throw new SearchProviderError('invalid-request');
        filters[key] = value;
      } else {
        if (typeof value !== 'string') throw new SearchProviderError('invalid-request');
        filters[key] = value;
      }
    }
    const result = await runConfiguredSearch({ projectRoot, repo: params.repo as string | undefined,
      providerIds: parseProviderSelection(params.providers), query: params.query,
      limit: params.limit as number | undefined, filters,
      mode: params.skipEmbedding === true ? 'lexical'
        : params.semantic === true || params.skipEmbedding === false ? 'hybrid' : 'auto',
      executionMode: params.readOnlyProbe === true || params.executionMode === 'read-only-probe' ? 'read-only-probe' : 'default',
      localSearch: async (request, scope) => {
        const { runUnifiedSearch } = await import('../../commands/search.js');
        const results = await runUnifiedSearch(request.query, {
          ...request.filters, repo: params.repo as string | undefined,
          projectRoot: scope.current.projectRoot,
          ...(params.repo !== undefined ? { targetRepository: scope.target } : {}),
          limit: request.candidateLimit, skipEmbedding: request.mode === 'auto' || request.mode === 'lexical',
          // Legacy impression attribution uses cwd, which need not be the MCP host root.
          deferImpressions: true, executionMode: request.executionMode,
        });
        return results.map(item => providerWikiItem(item, scope.authority.workspaceFence));
      },
    });
    if (result.providers.every(provider => provider.status === 'error')) {
      return { success: false, error: result.providers[0]?.code ?? 'provider-error', result };
    }
    return { success: true, result };
  } catch (error) {
    return { success: false, error: searchProviderErrorCode(error) };
  }
}
