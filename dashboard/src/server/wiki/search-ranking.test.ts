import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./search.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./search.js')>();
  return {
    ...actual,
    searchBM25Planned: vi.fn(actual.searchBM25Planned),
  };
});

import {
  buildInvertedIndex,
  buildQueryPlan,
  searchBM25,
  searchBM25Planned,
  tokenize,
} from './search.js';
import { WikiIndexer } from './wiki-indexer.js';
import type { WikiEntry, WikiNodeType } from './wiki-types.js';

interface CorpusDocument {
  id: string;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  body: string;
  status: 'active' | 'deprecated';
  workspace: string;
  authorized: boolean;
  provenance: { source: string; path: string };
}

interface CorpusFixture {
  documents: CorpusDocument[];
  latencyCorpus: {
    size: number;
    idPrefix: string;
    vocabulary: string[];
  };
}

interface QrelsFixture {
  queries: Array<{
    id: string;
    query: string;
    category: string;
    relevance: Record<string, number>;
  }>;
}

interface HoldoutsFixture {
  queries: Array<{
    id: string;
    query: string;
    targetIds: string[];
    category: string;
  }>;
}

interface RankingEvaluator {
  computeRankingMetrics(
    rankedIds: readonly string[],
    relevance: Readonly<Record<string, number>>,
  ): { ndcgAt10: number; mrrAt10: number; recallAt20: number };
  scanQuerySpecialCases(input: {
    queryFiles: readonly string[];
    productionPaths: readonly string[];
  }): Promise<{ querySpecialCaseHits: number }>;
}

const fixtureDir = resolve(
  import.meta.dirname,
  '../../../../src/search/evaluation/fixtures',
);
const qrelsPath = join(fixtureDir, 'search-ranking-qrels.json');
const holdoutsPath = join(fixtureDir, 'search-ranking-holdouts.json');
const corpusPath = join(fixtureDir, 'search-ranking-corpus.json');
const temporaryRoots: string[] = [];

async function loadRankingEvaluator(): Promise<RankingEvaluator> {
  const evaluatorUrl = pathToFileURL(resolve(
    import.meta.dirname,
    '../../../../src/search/evaluation/relevance-evaluator.ts',
  )).href;
  return import(/* @vite-ignore */ evaluatorUrl) as Promise<RankingEvaluator>;
}

function nodeType(kind: string): WikiNodeType {
  if (kind === 'knowhow') return 'knowhow';
  if (kind === 'spec') return 'spec';
  if (kind === 'domain-term' || kind === 'code-symbol') return 'domain';
  return 'project';
}

function wikiEntry(document: CorpusDocument): WikiEntry {
  return {
    id: document.id,
    type: nodeType(document.kind),
    title: document.title,
    summary: document.summary,
    tags: document.tags,
    status: document.status,
    created: '2026-07-23T00:00:00.000Z',
    updated: '2026-07-23T00:00:00.000Z',
    related: [],
    source: {
      kind: 'virtual',
      path: document.provenance.path,
      ...(document.workspace === 'local' ? {} : { workspace: document.workspace }),
    },
    body: document.body,
    ext: document.kind === 'code-symbol' ? { virtualKind: 'kg-node' } : {},
    scope: document.workspace === 'local' ? 'project' : 'linked',
    category: null,
    specCategory: null,
    createdBy: null,
    sourceRef: null,
    parent: null,
  };
}

function entry(
  id: string,
  title: string,
  body = title,
  overrides: Partial<WikiEntry> = {},
): WikiEntry {
  return {
    id,
    type: 'spec',
    title,
    summary: '',
    tags: [],
    status: 'active',
    created: '2026-07-23T00:00:00.000Z',
    updated: '2026-07-23T00:00:00.000Z',
    related: [],
    source: { kind: 'virtual', path: `${id}.md` },
    body,
    ext: {},
    scope: 'project',
    category: null,
    specCategory: null,
    createdBy: null,
    sourceRef: null,
    parent: null,
    ...overrides,
  };
}

async function loadFixture<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

afterEach(async () => {
  vi.mocked(searchBM25Planned).mockClear();
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 3 }),
  ));
});

describe('lexical recall regressions', () => {
  it.each([
    ['用户AuthToken流程', ['auth', 'token', 'authtoken'], ['auth token', 'AuthToken']],
    ['HTTP2Server', ['http2', 'server', 'http2server'], ['server', 'HTTP2Server']],
  ])('recalls identifier components and joined form: %s', (title, expectedTokens, queries) => {
    expect(tokenize(title)).toEqual(expect.arrayContaining(expectedTokens));
    const index = buildInvertedIndex([entry('target', title, '')]);
    for (const search of [searchBM25, searchBM25Planned]) {
      for (const query of queries) {
        expect(search(index, query, 1).map(result => result.docId), query).toEqual(['target']);
      }
    }
  });

  it('supports exact title/tag singleton lookup without admitting Latin body or CJK substring unigrams', () => {
    const index = buildInvertedIndex([
      entry('r-title', 'R', ''),
      entry('r-tag', 'Statistics', '', { tags: ['R'] }),
      entry('body-only', 'Notes', 'R '.repeat(100), { summary: 'R', category: 'R' }),
      entry('not-exact', 'R tutorial', '', { tags: ['R language'] }),
      entry('cjk-title', '锁', ''),
      entry('cjk-tag', 'Concurrency', '', { tags: ['锁'] }),
      entry('cjk-substring', '读写锁', '读写锁'.repeat(100)),
    ]);
    for (const search of [searchBM25, searchBM25Planned]) {
      for (const query of ['R', 'r', ' R ']) {
        expect(search(index, query, 10).map(result => result.docId).sort()).toEqual(['r-tag', 'r-title']);
        expect(search(index, query, 1, undefined, new Set(['r-tag'])).map(result => result.docId))
          .toEqual(['r-tag']);
      }
      expect(search(index, '锁', 10).map(result => result.docId).sort()).toEqual(['cjk-tag', 'cjk-title']);
    }
    expect(tokenize('R')).toEqual([]);
    expect(tokenize('读写锁')).toEqual(['读写', '写锁', '读写锁']);
    expect(index.fieldPostings.has('读')).toBe(false);
    // One bounded synthetic term for the exact Latin singleton, never body TF.
    const exact = [...index.fieldPostings].filter(([term]) => term.startsWith('\u0000singleton:'));
    expect(exact).toHaveLength(1);
    expect(exact[0][1]).toHaveLength(2);
    expect(exact[0][1].every(posting => posting.fieldTfs.body === 0)).toBe(true);
  });

  it('gives explicit synonym originals full weight regardless of order', () => {
    const index = buildInvertedIndex([
      entry('auth', 'Auth', ''),
      entry('authentication', 'Authentication', ''),
    ]);
    for (const search of [searchBM25, searchBM25Planned]) {
      const forward = search(index, 'auth authentication', 2);
      const reverse = search(index, 'authentication auth', 2);
      expect(forward.map(result => result.docId)).toEqual(reverse.map(result => result.docId));
      // Planned RRF intentionally breaks equal BM25 scores by document ID.
      if (search === searchBM25) expect(forward[0].score).toBeCloseTo(forward[1].score, 12);
      for (let i = 0; i < forward.length; i++) {
        expect(reverse[i].score).toBeCloseTo(forward[i].score, 12);
      }
    }
    for (const query of ['auth authentication', 'authentication auth']) {
      const weighted = buildQueryPlan(query).groups[0].weightedTerms;
      expect(weighted.find(term => term.term === 'auth')?.weight).toBe(1);
      expect(weighted.find(term => term.term === 'authentication')?.weight).toBe(1);
    }
  });

  it('ignores tokenless and duplicate raw parts in coverage and ranking', () => {
    const index = buildInvertedIndex([
      entry('complete', 'Contract', 'cache invalidation'),
      entry('partial', 'Cache', 'cache'),
      entry('other', 'Release workflow'),
    ]);
    const expected = searchBM25Planned(index, 'cache invalidation', 3);
    for (const query of ['cache invalidation ?', 'cache invalidation cache', 'cache invalidation CACHE']) {
      const plan = buildQueryPlan(query, index);
      expect(plan.coreCoverageTerms.map(term => term.key), query).toEqual(['cache', 'invalidation']);
      expect(searchBM25Planned(index, query, 3), query).toEqual(expected);
    }
    expect(buildQueryPlan('? a').coreCoverageTerms).toEqual([]);
  });

  it('credits all overlapping coverage keys without scoring a posting twice', () => {
    const index = buildInvertedIndex([
      entry('overlap', '缓存器', ''),
      entry('competitor', '缓存', ''),
      entry('other', 'Release', ''),
    ]);
    // Both documents match 缓存. The first also matches 存器 via the longer key;
    // matching 缓存 must satisfy BOTH searchable concepts, not only the first.
    const forward = searchBM25Planned(index, '缓存 缓存器', 3);
    const reverse = searchBM25Planned(index, '缓存器 缓存', 3);
    expect(forward.map(result => result.docId)).toEqual(reverse.map(result => result.docId));
    const unpenalized = searchBM25(index, '缓存 缓存器', 3);
    for (let i = 0; i < forward.length; i++) {
      const result = forward[i];
      expect(result.score).toBeCloseTo(reverse.find(other => other.docId === result.docId)!.score, 12);
      // Shared 缓存 gives BOTH docs full coverage. The single-group blend
      // therefore equals the unpenalized BM25 blend, with no duplicate TF.
      const expected = 0.3 * (11 / (11 + i)) + 0.7 * (unpenalized[i].score / unpenalized[0].score);
      expect(result.score).toBeCloseTo(expected, 12);
    }
  });
});

describe('planned Wiki ranking', () => {
  it('plans short queries and applies coverage-aware scoring without a legacy bypass', async () => {
    const entries = [
      entry('complete', 'Contract', 'cache invalidation'),
      entry('partial', 'Cache', 'cache'),
      entry('other', 'Release workflow'),
    ];
    const index = buildInvertedIndex(entries);
    const plan = buildQueryPlan('cache invalidation', index);
    const legacy = searchBM25(index, 'cache invalidation', 3);
    const planned = searchBM25Planned(index, 'cache invalidation', 3);
    const evaluator = await loadRankingEvaluator();
    const relevance = { complete: 1 };
    const legacyNdcg = evaluator.computeRankingMetrics(legacy.map(result => result.docId), relevance).ndcgAt10;
    const plannedNdcg = evaluator.computeRankingMetrics(planned.map(result => result.docId), relevance).ndcgAt10;

    expect(plan.tokens.map(token => token.normalized)).toEqual(['cache', 'invalidation']);
    expect(plan.groups).toHaveLength(1);
    expect(legacy[0]?.docId).toBe('partial');
    expect(planned[0]?.docId).toBe('complete');
    expect(plannedNdcg).toBeGreaterThanOrEqual(legacyNdcg * 1.1);
  });

  it('keeps the undefined credibility golden and reorders with the supplied map', () => {
    const index = buildInvertedIndex([
      entry('alpha-a', 'Alpha contract'),
      entry('alpha-b', 'Alpha contract'),
    ]);

    expect(searchBM25Planned(index, 'alpha', 2).map(result => result.docId))
      .toEqual(['alpha-a', 'alpha-b']);

    const factors = new Map([
      ['alpha-a', 0.2],
      ['alpha-b', 1],
    ]);
    const ranked = searchBM25Planned(index, 'alpha', 2, factors);
    expect(ranked.map(result => result.docId)).toEqual(['alpha-b', 'alpha-a']);
    expect(ranked[1].score).toBeLessThan(ranked[0].score);
  });

  it('passes the identical credibility Map from WikiIndexer to planned search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-ranking-map-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(
      join(root, 'specs', 'ranking.md'),
      '---\ntitle: Ranking contract\n---\n# Ranking contract\nStable ranking.',
      'utf8',
    );
    const factors = new Map([['spec:project:ranking', 0.8]]);

    await new WikiIndexer({ workflowRoot: root }).searchWithMeta(
      'ranking',
      5,
      { skipEmbedding: true, credibilityFactors: factors },
    );

    expect(vi.mocked(searchBM25Planned)).toHaveBeenCalledWith(
      expect.anything(),
      'ranking',
      60,
      factors,
      undefined,
    );
  });

  it('retains TASK-001 relevance and is deterministic across five runs', async () => {
    const [corpus, qrels, evaluator] = await Promise.all([
      loadFixture<CorpusFixture>(corpusPath),
      loadFixture<QrelsFixture>(qrelsPath),
      loadRankingEvaluator(),
    ]);
    const documents = corpus.documents
      .filter(document => document.authorized && document.status !== 'deprecated')
      .map(wikiEntry);
    const index = buildInvertedIndex(documents);
    const runs = Array.from({ length: 5 }, () =>
      qrels.queries.map(judgment =>
        searchBM25Planned(index, judgment.query, 20).map(result => result.docId),
      ),
    );

    expect(runs.slice(1)).toEqual(Array(4).fill(runs[0]));
    const ndcgByCategory = new Map<string, number[]>();
    for (let queryIndex = 0; queryIndex < qrels.queries.length; queryIndex++) {
      const judgment = qrels.queries[queryIndex];
      const metrics = evaluator.computeRankingMetrics(runs[0][queryIndex], judgment.relevance);
      expect(metrics.mrrAt10, judgment.id).toBe(1);
      const categoryMetrics = ndcgByCategory.get(judgment.category) ?? [];
      categoryMetrics.push(metrics.ndcgAt10);
      ndcgByCategory.set(judgment.category, categoryMetrics);
    }
    for (const [category, values] of ndcgByCategory) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(mean, category).toBeGreaterThanOrEqual(0.98);
    }
    expect(ndcgByCategory.get('wiki-short')).toEqual([1, 1, 1]);
  });

  it('answers two external paraphrase and word-order holdouts without query branches', async () => {
    const [holdouts, evaluator] = await Promise.all([
      loadFixture<HoldoutsFixture>(holdoutsPath),
      loadRankingEvaluator(),
    ]);
    const piHoldouts = holdouts.queries.filter(query => query.category === 'pi');
    const canonical = entry(
      piHoldouts[0].targetIds[0],
      'Canonical generation workflow for skills',
      'Pi skills are generated from a canonical source workflow.',
    );
    const index = buildInvertedIndex([
      canonical,
      entry('distractor', 'Manual plugin notes', 'Unrelated configuration details.'),
    ]);

    expect(piHoldouts).toHaveLength(2);
    for (const holdout of piHoldouts) {
      expect(searchBM25Planned(index, holdout.query, 5)[0]?.docId, holdout.id)
        .toBe(canonical.id);
    }

    const scan = await evaluator.scanQuerySpecialCases({
      queryFiles: [qrelsPath, holdoutsPath],
      productionPaths: [
        resolve(import.meta.dirname, 'search.ts'),
        resolve(import.meta.dirname, 'wiki-indexer.ts'),
      ],
    });
    expect(scan.querySpecialCaseHits).toBe(0);
  });

  it('meets the 2000-document index and query latency budgets', async () => {
    const corpus = await loadFixture<CorpusFixture>(corpusPath);
    const documents = corpus.documents
      .filter(document => document.authorized && document.status !== 'deprecated')
      .map(wikiEntry);
    for (let index = documents.length; index < corpus.latencyCorpus.size; index++) {
      const words = corpus.latencyCorpus.vocabulary;
      documents.push(entry(
        `${corpus.latencyCorpus.idPrefix}-${String(index).padStart(4, '0')}`,
        `${words[index % words.length]} ${words[(index + 1) % words.length]}`,
        `${words[(index + 2) % words.length]} ${words[(index + 3) % words.length]}`,
      ));
    }

    const indexStarted = performance.now();
    const index = buildInvertedIndex(documents);
    const indexMs = performance.now() - indexStarted;
    for (let warmup = 0; warmup < 20; warmup++) {
      searchBM25Planned(index, 'wiki architecture', 20);
    }
    const samples: number[] = [];
    for (let sample = 0; sample < 100; sample++) {
      const started = performance.now();
      searchBM25Planned(index, 'wiki architecture', 20);
      samples.push(performance.now() - started);
    }

    expect(index.totalDocs).toBe(2000);
    expect(indexMs).toBeLessThan(500);
    expect(percentile(samples, 0.95)).toBeLessThan(50);
  });

  it('keeps the planned blend distinct from legacy BM25 for multi-signal queries', () => {
    const index = buildInvertedIndex([
      entry('anchor', 'AuthTokenValidator', 'authentication callback validator'),
      entry('context', 'Dashboard authentication', 'validator callback'),
      entry('noise', 'Authentication guide'),
    ]);

    const legacy = searchBM25(index, 'AuthTokenValidator dashboard authentication callback', 3);
    const planned = searchBM25Planned(
      index,
      'AuthTokenValidator dashboard authentication callback',
      3,
    );

    expect(planned.map(result => result.docId)).not.toEqual([]);
    expect(planned.map(result => result.score)).not.toEqual(legacy.map(result => result.score));
    expect(planned[0].docId).toBe('anchor');
  });
});
