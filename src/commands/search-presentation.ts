/** CLI-only projections: provider results, scores and ordering remain untouched. */
import { stripVTControlCharacters } from 'node:util';

interface PresentationResult {
  id: string;
  name: string;
  kind: string;
  source?: string;
  sourceType?: string;
  detail?: string;
  openCommand?: string;
  filePath?: string;
  line?: number | null;
  signature?: string;
  snippet?: string;
  summary?: string;
  definition?: string;
  sourceRef?: string | null;
  workspace?: string;
  alias?: string;
  repoId?: string | null;
  repoName?: string;
  workspaceFence?: string;
  referenceOnly?: boolean;
  confidence?: string;
  status?: string;
  appliesToRepoIds?: string[] | null;
}

export interface CompactResult {
  source: string;
  id: string;
  kind: string;
  name: string;
  preview?: string;
  /** The single load route for reference-only architecture templates. */
  openCommand?: string;
  filePath?: string;
  line?: number;
  workspace?: string;
  alias?: string;
  repoId?: string;
  repoName?: string;
  workspaceFence?: string;
  referenceOnly?: boolean;
  confidence?: string;
  status?: string;
  appliesToRepoIds?: string[];
}

interface SearchPayloadInput {
  query: string;
  count: number;
  results: readonly PresentationResult[];
  hint?: string;
  codeIndexHint?: string;
  warnings?: string[];
  diagnostics?: unknown;
}
export interface CompactSearchPayload {
  query: string;
  count: number;
  results: CompactResult[];
  hint?: string;
  warnings?: string[];
  diagnostics?: unknown;
}

function excerpt(result: PresentationResult): string | undefined {
  for (const value of [result.signature, result.snippet, result.summary, result.definition]) {
    if (!value?.trim()) continue;
    const comparable = value.replace(/^L\d+:\s*/, '').replace(/^#+\s*/, '').trim();
    if (comparable === result.name.trim()) continue;
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }
  return undefined;
}

function compactResult(result: PresentationResult): CompactResult {
  const compact: CompactResult = {
    source: result.source ?? result.sourceType ?? 'kg',
    id: result.id,
    kind: result.kind,
    name: result.name,
  };
  const preview = excerpt(result);
  if (preview) compact.preview = preview;
  if (compact.source === 'arch-kb' && result.kind === 'template' && result.openCommand) {
    compact.openCommand = result.openCommand;
  }
  let filePath = result.filePath;
  let line = result.line;
  // Mixed code stores its coordinates in detail; do not change MergedResult.
  if (!filePath && result.source === 'code' && result.detail) {
    const location = /^(.*):(\d+)$/.exec(result.detail);
    filePath = location ? location[1] : result.detail;
    if (location) line = Number(location[2]);
  }
  if (!filePath && result.source === 'arch-kb') filePath = result.sourceRef ?? undefined;
  if (filePath) compact.filePath = filePath;
  if (typeof line === 'number' && line > 0) compact.line = line;
  const linked = (result.workspace && result.workspace !== 'current')
    || (result.alias && result.alias !== 'current');
  if (linked) {
    if (result.workspace && result.workspace !== 'current') compact.workspace = result.workspace;
    if (result.alias && result.alias !== 'current') compact.alias = result.alias;
    if (result.repoId) compact.repoId = result.repoId;
    if (result.repoName) compact.repoName = result.repoName;
    if (result.workspaceFence) compact.workspaceFence = result.workspaceFence;
  }
  if (result.referenceOnly) compact.referenceOnly = true;
  if (result.confidence === 'low' || result.confidence === 'contested') compact.confidence = result.confidence;
  if (result.status && !['active', 'current', 'completed'].includes(result.status)) compact.status = result.status;
  if (result.appliesToRepoIds?.length) compact.appliesToRepoIds = [...result.appliesToRepoIds];
  return compact;
}

export function compactSearchPayload(payload: SearchPayloadInput): CompactSearchPayload {
  const compact: CompactSearchPayload = {
    query: payload.query,
    count: payload.count,
    results: payload.results.map(compactResult),
  };
  const hint = payload.hint ?? payload.codeIndexHint;
  if (hint) compact.hint = hint;
  if (payload.warnings?.length) compact.warnings = payload.warnings;
  if (payload.diagnostics) compact.diagnostics = payload.diagnostics;
  return compact;
}

/** Strip untrusted terminal/bidi controls without changing legacy spacing. JSON stays raw. */
export function safeSearchLine(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

/** Compact text additionally folds whitespace; never apply to an assembled legacy row. */
export function safeSearchText(value: string): string {
  return safeSearchLine(value).replace(/\s+/g, ' ').trim();
}
function shortText(value: string, max: number): string {
  const safe = safeSearchText(value);
  return safe.length > max ? `${safe.slice(0, max - 3)}...` : safe;
}

export function renderCompactSearch(payload: CompactSearchPayload): string[] {
  const lines = [`Search: "${safeSearchText(payload.query)}" (${payload.count} results)`];
  if (payload.hint) lines.push(`  Note: ${safeSearchText(payload.hint)}`);
  for (const warning of payload.warnings ?? []) lines.push(`  Warning: ${safeSearchText(warning)}`);
  if (payload.count === 0) lines.push('  No matches found.');
  for (const result of payload.results) {
    const identity = safeSearchText(result.id);
    const name = shortText(result.name, 100);
    const location = result.filePath
      ? `  ${safeSearchText(result.filePath)}${result.line ? `:${result.line}` : ''}` : '';
    const boundary = result.workspace ?? result.alias;
    const fence = result.workspaceFence ?? (result.repoId ? `repo:${result.repoId}` : undefined);
    const tags = [
      result.referenceOnly ? 'reference only; not current project' : '',
      result.confidence ? `${result.confidence} confidence` : '',
      result.status ?? '',
      boundary ? `@${boundary}${fence ? `; ${fence}` : ''}` : '',
      result.appliesToRepoIds ? `applies to: ${result.appliesToRepoIds.join(', ')}` : '',
    ].filter(Boolean).map(tag => ` [${safeSearchText(tag)}]`).join('');
    lines.push(`  [${safeSearchText(result.source)}:${safeSearchText(result.kind)}] ${identity}${name !== identity ? `  ${name}` : ''}${location}${tags}`);
    if (result.preview) lines.push(`    ${shortText(result.preview, 200)}`);
    if (result.openCommand) lines.push(`    ${safeSearchText(result.openCommand)}`);
  }
  return lines;
}

/** Do not dump driver errors/paths; retain actionable, bounded partial coverage. */
export function linkedCodeWarnings(outcome: { linkedFailures?: Array<{ workspace: string }> }): string[] {
  const failures = outcome.linkedFailures ?? [];
  const warnings = failures.slice(0, 3).map(failure =>
    `Linked code workspace "${failure.workspace.slice(0, 80)}" unavailable — rerun with MAESTRO_DEBUG=1 for details`,
  );
  if (failures.length > 3) warnings.push(`${failures.length - 3} additional linked code workspaces unavailable`);
  return warnings;
}
