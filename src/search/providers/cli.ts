import { SearchProviderError, SEARCH_PROVIDER_SCHEMA, type UnifiedSearchResponse } from '../../../shared/search-provider.js';
import type { SearchResult, UnifiedSearchOptions } from '../../commands/search.js';
import { safeSearchLine, safeSearchText } from '../../commands/search-presentation.js';
import { searchProviderErrorCode } from './gateway.js';
import type { LocalSearchItem } from './local.js';
import { parseProviderSelection, runConfiguredSearch } from './runtime.js';

export interface ProviderCliOptions {
  providers?: string;
  limit?: string | number;
  repo?: string;
  type?: string;
  category?: string;
  tag?: string;
  /** Legacy CLI alias for tag, not a provider-defined kind. */
  kind?: string;
  workspace?: string;
  includeDeprecated?: boolean;
  wikiOnly?: boolean;
  semantic?: boolean;
  emb?: boolean;
  readOnlyProbe?: boolean;
  json?: boolean;
  exact?: boolean;
  kg?: boolean;
  code?: boolean;
  includeLinkedCode?: boolean;
  full?: boolean;
  timeoutMs?: string;
  maxResults?: string;
  maxBytes?: string;
}

export function providerWikiItem(result: SearchResult, workspaceFence: string): LocalSearchItem {
  return { id: result.id, title: result.title, snippet: result.snippet, summary: result.summary,
    score: result.score, sourceRef: result.sourceRef, path: result.provenance?.path ?? result.source.path,
    workspaceFence: result.workspaceFence ?? result.source.workspaceFence ?? workspaceFence };
}

/** Loaded only by explicit --providers; the original CLI route never imports this module. */
export async function runProviderCli(query: string, options: ProviderCliOptions): Promise<UnifiedSearchResponse | undefined> {
  try {
    if ([options.exact, options.kg, options.code, options.includeLinkedCode, options.full].some(value => value === true)
      || options.timeoutMs !== undefined || options.maxResults !== undefined || options.maxBytes !== undefined
      || (options.semantic === true && options.emb === false)
      || (options.tag !== undefined && options.kind !== undefined && options.tag !== options.kind)) {
      throw new SearchProviderError('invalid-request');
    }
    const limit = options.limit === undefined ? 20 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new SearchProviderError('invalid-request');
    if (options.type !== undefined && !['project', 'roadmap', 'spec', 'issue', 'knowhow', 'note', 'domain', 'session', 'scratch', 'template'].includes(options.type)) {
      throw new SearchProviderError('invalid-request');
    }
    const result = await runConfiguredSearch({ projectRoot: process.cwd(), repo: options.repo,
      providerIds: parseProviderSelection(options.providers), query, limit,
      mode: options.semantic === true ? 'hybrid' : options.emb === false ? 'lexical' : 'auto',
      filters: { type: options.type, category: options.category, tag: options.tag ?? options.kind,
        workspace: options.workspace, includeDeprecated: options.includeDeprecated },
      executionMode: options.readOnlyProbe === true ? 'read-only-probe' : 'default',
      localSearch: async (request, scope) => {
        const engine = await import('../../commands/search.js');
        const searchOptions: UnifiedSearchOptions & { skipEmbedding: boolean } = {
          ...request.filters, limit: request.candidateLimit, repo: options.repo,
          projectRoot: scope.current.projectRoot,
          ...(options.repo !== undefined ? { targetRepository: scope.target } : {}),
          skipEmbedding: request.mode === 'auto' || request.mode === 'lexical', executionMode: request.executionMode,
          // Candidate retrieval is not final exposure after cross-provider fusion.
          deferImpressions: true,
        };
        if (request.filters.type === 'template') {
          if (request.filters.category || request.filters.tag || request.filters.workspace) return [];
          return engine.runArchKbSearch(query, request.candidateLimit).map(({ entry, score }) => ({
            id: entry.id, title: entry.title, summary: entry.summary, score, kind: 'document' as const,
            sourceRef: entry.path, path: entry.path, referenceOnly: true,
          }));
        }
        if (options.wikiOnly === true) {
          return (await engine.runUnifiedSearch(query, searchOptions)).map(item => providerWikiItem(item, scope.authority.workspaceFence));
        }
        // Code has no wiki facet contract; never let it bypass a requested facet or linked target.
        const wikiFacet = Boolean(request.filters.type || request.filters.category || request.filters.tag || request.filters.keyword || request.filters.workspace);
        const mixed = await engine.runMixedSearch(query, searchOptions, {
          wikiSearch: (q, wikiOptions) => engine.runUnifiedSearch(q, { ...wikiOptions, deferImpressions: true }),
          codeSearch: async (q, candidateLimit, skipEmbedding) => wikiFacet || scope.target.relation !== 'current'
            ? { results: [], status: 'ok' }
            : engine.runCodeSearch(q, candidateLimit, skipEmbedding, false, scope.current.projectRoot, request.executionMode),
        });
        return mixed.results.map(item => {
          if (item.source === 'wiki') {
            const wiki = mixed.wikiResults.find(candidate => candidate.id === item.id);
            if (!wiki) throw new SearchProviderError('provider-error');
            return providerWikiItem(wiki, scope.authority.workspaceFence);
          }
          const code = mixed.codeOutcome.results.find(candidate => candidate.id === item.id);
          return { id: item.id, title: item.name, snippet: item.snippet ?? item.signature, summary: item.summary,
            score: item.score, kind: item.source === 'code' ? 'code' as const : 'document' as const,
            sourceRef: item.sourceRef, path: code?.provenance?.path ?? code?.filePath ?? item.sourceRef ?? undefined,
            workspaceFence: item.workspaceFence ?? code?.workspaceFence ?? scope.authority.workspaceFence,
            ...(item.source === 'arch-kb' ? { referenceOnly: true } : {}) };
        });
      },
    });
    if (result.providers.every(provider => provider.status === 'error')) process.exitCode = 1;
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Search: "${safeSearchLine(query)}" (${result.results.length} results)`);
      for (const provider of result.providers) {
        console.log(`  [${safeSearchText(provider.id)}] ${safeSearchText(provider.status)}${provider.code ? `: ${safeSearchText(provider.code)}` : ''}`);
      }
      for (const item of result.results) {
        console.log(`  [${safeSearchText(item.ref.providerId)}:${item.kind}] ${safeSearchLine(item.title)}${item.referenceOnly ? ' [reference only]' : ''}`);
        if (item.snippet) console.log(`    ${safeSearchText(item.snippet)}`);
      }
    }
    return result;
  } catch (error) {
    const code = searchProviderErrorCode(error);
    process.exitCode = 1;
    if (options.json) console.log(JSON.stringify({ schemaVersion: SEARCH_PROVIDER_SCHEMA, error: code, mutationAuthorized: false }));
    else console.error(`Error: ${code}`);
    return undefined;
  }
}
