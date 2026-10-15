import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaestroGraph } from '../engine.js';
import type { UnifiedNode } from '../db/types.js';
import { runKgSearch } from '../../../commands/search.js';

vi.mock('#maestro-dashboard/wiki/embedding.js', () => ({
  embedQuery: vi.fn(async () => new Float32Array([1, 0])),
}));

function node(id: string, overrides: Partial<UnifiedNode> = {}): UnifiedNode {
  return {
    id, kind: 'spec_entry', name: 'EligibilityNeedle', qualifiedName: 'EligibilityNeedle',
    filePath: `${id}.md`, language: 'markdown', startLine: 1, endLine: 1,
    startColumn: 0, endColumn: 0, docstring: '', signature: '', visibility: '',
    isExported: false, isAsync: false, isStatic: false, isAbstract: false,
    decorators: [], typeParameters: [], sourceType: 'spec', definition: 'EligibilityNeedle',
    aliases: [], keywords: [], category: 'coding', roles: [], priority: '',
    status: 'active', body: '', metadata: {}, updatedAt: 0, ...overrides,
  };
}

let graph: MaestroGraph | undefined;
let root: string;
async function corpus(overrides: Partial<UnifiedNode> = {}) {
  root = mkdtempSync(join(tmpdir(), 'kg-eligibility-'));
  graph = await MaestroGraph.init(root);
  graph.getConnection().transaction(() => graph!.getQueryBuilder().insertNodes([
    ...Array.from({ length: 550 }, (_, i) => node(`spec:noise-${i}`, {
      category: i % 2 ? 'coding' : 'other', status: i % 2 ? 'deprecated' : 'active', ...overrides,
    })),
    node('spec:target', { name: 'EligibilityNeedle target', definition: 'EligibilityNeedle target', ...overrides, category: 'coding', status: 'active' }),
  ]));
  return graph;
}

afterEach(() => {
  vi.restoreAllMocks();
  graph?.close(); graph = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('KG eligibility before candidate truncation', () => {
  it.each(['EligibilityNeedle', '资格'])('filters real FTS/LIKE candidates before LIMIT (%s)', async query => {
    const g = await corpus(query === '资格' ? { name: '资格', definition: '资格' } : {});
    const options = { limit: 1, sourceTypes: ['spec'] as const, category: 'coding', includeDeprecated: false };
    const queryOptions = { ...options, sourceTypes: [...options.sourceTypes] };
    expect(g.getQueryBuilder().searchKnowledgeFTS(query, { limit: 500 }).map(n => n.id)).not.toContain('spec:target');
    expect((await g.searchHybrid(query, queryOptions)).map(r => r.node.id)).toEqual(['spec:target']);
    expect(g.getQueryBuilder().searchKnowledgeFTS(query, queryOptions).map(n => n.id)).toEqual(['spec:target']);
    expect(g.searchUnified(query, queryOptions).directMatches.map(r => r.node.id)).toEqual(['spec:target']);
    // The CLI's 40-candidate default (and 500 hard cap) must not hide this target.
    graph!.close(); graph = undefined;
    expect((await runKgSearch(query, 1, false, root, { type: 'spec', category: 'coding' })).results.map(r => r.graphId)).toEqual(['spec:target']);
  });

  it('keeps defaults unchanged, opt-in deprecated, exact parameterized category, and source boundaries', async () => {
    const g = await corpus();
    expect(g.searchUnified('EligibilityNeedle', { limit: 1, sourceTypes: ['spec'], category: 'coding', includeDeprecated: false }).directMatches[0]?.node.id).toBe('spec:target');
    expect(g.searchUnified('EligibilityNeedle', { limit: 1, sourceTypes: ['spec'], category: 'coding', includeDeprecated: true }).directMatches[0]?.node.status).toBe('deprecated');
    expect(g.searchUnified('EligibilityNeedle', { limit: 1 }).directMatches).toHaveLength(1);
    expect(g.searchUnified('EligibilityNeedle', { category: "coding' OR 1=1 --" }).directMatches).toEqual([]);
    expect(g.searchUnified('EligibilityNeedle', { sourceTypes: [] }).directMatches).toEqual([]);
    g.getQueryBuilder().insertNodes([node('code:outsider', { kind: 'function', sourceType: 'codegraph' })]);
    expect(g.searchUnified('EligibilityNeedle', { sourceTypes: ['spec'], limit: 500 }).directMatches.every(r => r.node.sourceType === 'spec')).toBe(true);
  });

  it.each(['EligibilityNeedle', '资格'])('filters code FTS/LIKE before its bounded candidate pool (%s)', async query => {
    const g = await corpus({ sourceType: 'codegraph', kind: 'function', name: query, docstring: query });
    const options = { sourceTypes: ['codegraph'] as const, category: 'coding', includeDeprecated: false, limit: 1 };
    expect(g.getQueryBuilder().searchCodeFTS(query, { ...options, sourceTypes: [...options.sourceTypes] }).map(n => n.id)).toEqual(['spec:target']);
    expect(g.searchUnified(query, { ...options, sourceTypes: [...options.sourceTypes] }).directMatches.map(r => r.node.id)).toEqual(['spec:target']);
  });

  it('keeps candidate output bounded when the eligible pool is large', async () => {
    const g = await corpus({ category: 'coding', status: 'active' });
    const options = { category: 'coding', includeDeprecated: false, limit: 40 };
    expect(g.getQueryBuilder().searchKnowledgeFTS('EligibilityNeedle', options)).toHaveLength(40);
    expect(g.searchUnified('EligibilityNeedle', options).directMatches).toHaveLength(40);
    expect(g.searchUnified('EligibilityNeedle', { ...options, limit: 9999 }).directMatches).toHaveLength(500);
  });

  it('applies kind eligibility before the knowledge candidate limit', async () => {
    const g = await corpus();
    g.getQueryBuilder().insertNodes([node('spec:kind-target', { kind: 'knowhow_entry' })]);
    expect(g.searchUnified('EligibilityNeedle', { kinds: ['knowhow_entry'], limit: 1 }).directMatches.map(r => r.node.id)).toEqual(['spec:kind-target']);
  });

  it('filters real hybrid vector candidates before vector top-K and RRF truncation', async () => {
    const g = await corpus({ sourceType: 'codegraph', kind: 'function' });
    const nodes = g.getQueryBuilder().getNodesBySourceType('codegraph');
    // No lexical match: only the real vector scan can recover the eligible target.
    vi.spyOn(g, 'getCodeEmbeddingIndex').mockResolvedValue({
      modelId: 'test', dimension: 2, nodeIds: nodes.map(n => n.id),
      vectors: nodes.map(n => new Float32Array(n.id === 'spec:target' ? [0.5, 0.5] : [1, 0])), builtAt: 0,
    });
    const options = { limit: 1, sourceTypes: ['codegraph' as const], category: 'coding', includeDeprecated: false };
    expect((await g.searchHybrid('semantic-only-query', options)).map(r => r.node.id)).toEqual(['spec:target']);
    expect(await g.searchHybrid('semantic-only-query', { ...options, sourceTypes: ['spec'] })).toEqual([]);
    expect(await g.searchHybrid('semantic-only-query', { ...options, category: "coding' OR 1=1 --" })).toEqual([]);
    expect((await g.searchHybrid('semantic-only-query', { ...options, includeDeprecated: true }))[0]?.node.status).toBe('deprecated');
  });
});
