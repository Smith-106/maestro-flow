import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditKnowledge } from './audit.js';
import { createRun } from '../run/runtime.js';
import { SessionStore } from '../run/store.js';
import type { RunV30, SessionStateV30 } from '../run/schemas.js';
import {
  addCandidate,
  createSessionDelta,
  runKnowledgeDeltaSchema,
  sessionKnowledgeDeltaSchema,
  summarizeSessionKnowledge,
} from '../run/knowledge.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'maestro-knowledge-audit-'));
  roots.push(path);
  mkdirSync(join(path, '.workflow'), { recursive: true });
  writeFileSync(join(path, '.workflow', 'config.json'), JSON.stringify({
    session_schema: {
      schema_version: 'session-schema-selection/1.0',
      writer: 'session/1.3',
      features: { session_statusless: false },
    },
  }), 'utf8');
  return path;
}

function writeUnsynchronizedChain(projectRoot: string): string {
  const dir = join(projectRoot, '.workflow', 'specs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'coding-conventions.md');
  writeFileSync(path, `---
category: coding
---

<spec-entry category="coding" keywords="store" date="2026-07-01" sid="S-old" title="Old store rule">

### Old store rule

Use the old store.

</spec-entry>

<spec-entry category="coding" keywords="store" date="2026-07-02" sid="S-new" title="New store rule" supersedes="S-old">

### New store rule

Use the canonical store.

</spec-entry>
`, 'utf8');
  return path;
}

function installCommand(projectRoot: string): void {
  const commandDir = join(projectRoot, '.claude', 'commands');
  const workflowDir = join(projectRoot, 'workflows');
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(commandDir, 'audit-demo.md'),
    '<contract>\nconsumes: []\nproduces: []\ngates:\n  entry: []\n  exit: []\n</contract>\n',
    'utf8',
  );
  writeFileSync(join(workflowDir, 'audit-demo.md'), '# audit-demo\n', 'utf8');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeV3Session(projectRoot: string, sessionId = 'v3-session'): string {
  const dir = join(projectRoot, '.workflow', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const session: SessionStateV30 = {
    schema_version: 'session/3.0', session_id: sessionId,
    objective: 'audit canonical authority', definition_of_done: 'read-only audit includes v3 knowledge',
    status: 'open', orchestration_revision: 0, activity_revision: 0,
    chain: [], decisions: [], active_run_ids: [],
    artifacts_ref: 'artifacts.json', evidence_ref: 'evidence.json',
    created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z',
    completed_at: null, archived_at: null,
  };
  writeJson(join(dir, 'session.json'), session);
  return dir;
}

function writeV3Run(sessionDir: string, sessionId: string, runId: string): string {
  const dir = join(sessionDir, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  const run: RunV30 = {
    schema_version: 'run/3.0', run_id: runId, session_id: sessionId, step_id: 'step-1',
    parent_run_id: null, retry_of_run_id: null, attempt: 1, command: 'implement', args: [],
    goal: null, status: 'completed', revision: 0, actor_id: 'audit-test',
    input_refs: [], output_refs: [], primary_artifact_id: null, verdict: 'done', summary: null,
    created_at: '2026-08-23T00:00:00.000Z', started_at: null, ended_at: null, sealed_at: null,
  };
  writeJson(join(dir, 'run.json'), run);
  return dir;
}

// Includes directories, bytes and mtimes: catches lock/repair/projection/corpus writes.
function snapshot(dir: string): unknown[] {
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(path) : readFileSync(path).toString('hex')];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('knowledge audit and pruning', () => {
  it.each(['1.0', '1.1'] as const)('audits v3 Run and Session ledgers (%s) without mutations', async version => {
    const projectRoot = root();
    const sessionId = 'v3-session';
    const dir = writeV3Session(projectRoot, sessionId);
    const source = { repo_id: '12345678-1234-4234-8234-123456789abc', workspace_id: 'test-workspace' };
    const sessionLedger = createSessionDelta(sessionId, '2026-08-23T00:00:00.000Z', version === '1.1' ? source : null);
    for (const title of ['Promoted', 'Corroborated', 'Observed']) {
      addCandidate(sessionLedger, {
        target: 'spec', action: 'propose', title, content: `${title} audit knowledge`,
        category: 'arch', source_kind: 'manual', evidence_refs: ['inline:audit evidence'],
      }, sessionLedger.created_at);
    }
    const [promoted, corroborated, observed] = sessionLedger.candidates;
    promoted.status = 'promoted';
    promoted.promoted_id = 'spec:project:fixture-promoted';
    if ('schema_version' in promoted) {
      promoted.promotion_receipt = {
        schema_version: 'knowledge-promotion-receipt/1.1', outcome: 'created',
        promoted_at: sessionLedger.created_at, content_hash: 'a'.repeat(64),
        target_repo_id: source.repo_id, target_workspace_id: source.workspace_id,
        target_alias_snapshot: 'current', planned_id: promoted.promoted_id,
        acknowledged_payload_hash: 'b'.repeat(64),
      };
    } else {
      promoted.promotion_receipt = {
        outcome: 'created', promoted_at: sessionLedger.created_at, content_hash: 'a'.repeat(64),
      };
    }
    for (const [runId, candidates] of [
      ['run-a', [promoted, corroborated, observed]],
      ['run-b', [corroborated]],
    ] as const) {
      const runDir = writeV3Run(dir, sessionId, runId);
      const { schema_version: _schema, ...base } = sessionLedger;
      writeJson(join(runDir, 'knowledge-delta.json'), runKnowledgeDeltaSchema.parse({
        ...base, schema_version: `run-knowledge-delta/${version}`, run_id: runId, candidates,
      }));
    }
    // Same ID across origins must not merge or corroborate the Session candidate.
    sessionLedger.candidates = [corroborated];
    writeJson(join(dir, 'knowledge-delta.json'), sessionKnowledgeDeltaSchema.parse(sessionLedger));

    const before = snapshot(projectRoot);
    vi.spyOn(SessionStore.prototype, 'withLock').mockImplementation(() => { throw new Error('audit must not acquire locks'); });
    vi.spyOn(SessionStore.prototype, 'readJsonFile').mockImplementation(() => { throw new Error('audit must use read-only ledgers'); });
    const report = await auditKnowledge(projectRoot);
    expect(report.pipeline).toEqual({
      sessions: 1, ledgers: 3, promoted: 1, pending_observed: 2, pending_corroborated: 1,
    });
    expect(report.findings.filter(item => item.subtype.startsWith('invalid-'))).toEqual([]);
    expect(report.findings).toContainEqual(expect.objectContaining({ subtype: 'corroborated-promotion-backlog' }));
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it.each(['pending', 'promoting'] as const)('includes v3 cross-repository %s candidates in compatibility diagnostics', async status => {
    const projectRoot = root();
    const sessionId = 'v3-cross-repo';
    const dir = writeV3Session(projectRoot, sessionId);
    const sourceId = '12345678-1234-4234-8234-123456789abc';
    const targetId = '87654321-4321-4321-8321-cba987654321';
    const ledger = createSessionDelta(sessionId, '2026-08-23T00:00:00.000Z', {
      repo_id: sourceId, workspace_id: 'source-workspace',
    });
    const candidateId = addCandidate(ledger, {
      target: 'spec', action: 'propose', title: 'Linked repository constraint',
      content: 'Keep linked repository publication explicit.', category: 'arch',
      source_kind: 'manual', evidence_refs: ['inline:cross-repository evidence'],
      target_repository: { repoId: targetId, workspaceId: 'target-workspace', alias: 'linked' },
    }, ledger.created_at);
    ledger.candidates[0].status = status;
    writeJson(join(dir, 'knowledge-delta.json'), sessionKnowledgeDeltaSchema.parse(ledger));
    const before = snapshot(projectRoot);
    const report = await auditKnowledge(projectRoot);
    expect(report.compatibility.pending_cross_repo_promotions).toEqual([{
      session_id: sessionId, candidate_id: candidateId, target: 'spec', status,
      source_repo_id: sourceId, target_repo_id: targetId, target_alias_snapshot: 'linked',
    }]);
    expect(report.compatibility.counts.pending_cross_repo_promotions).toBe(1);
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it.each(['missing', 'empty', 'inputs', 'candidates'] as const)('counts only nonempty Session ledgers: %s', async kind => {
    const projectRoot = root();
    const dir = writeV3Session(projectRoot);
    const ledger = createSessionDelta('v3-session');
    if (kind === 'inputs') ledger.inputs.push({
      knowledge_id: 'spec:project:loaded', signal: 'consumed', source: 'load', count: 135,
      first_recorded_at: ledger.created_at, last_recorded_at: ledger.created_at,
    });
    if (kind === 'candidates') addCandidate(ledger, {
      target: 'spec', action: 'propose', title: 'Session only', content: 'Session candidate content',
      category: 'arch', source_kind: 'manual', evidence_refs: ['inline:evidence'],
    }, ledger.created_at);
    if (kind !== 'missing') writeJson(join(dir, 'knowledge-delta.json'), ledger);
    const before = snapshot(projectRoot);
    const summary = summarizeSessionKnowledge(projectRoot, 'v3-session', { readOnly: true, strict: true });
    const count = kind === 'inputs' || kind === 'candidates' ? 1 : 0;
    expect(summary.ledger_count).toBe(count);
    expect(summary.run_count).toBe(0);
    expect(summary.input_totals.consumed).toBe(kind === 'inputs' ? 135 : 0);
    expect((await auditKnowledge(projectRoot)).pipeline.ledgers).toBe(count);
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it('enumerates canonical legacy and v3 authority while rejecting malformed and mismatched Sessions', async () => {
    const projectRoot = root();
    const store = new SessionStore(projectRoot);
    store.createSession('legacy-v13', 'legacy read compatibility');
    // Canonical v2 identity is readable without requiring its legacy projection.
    writeJson(join(projectRoot, '.workflow', 'config.json'), {
      session_schema: { schema_version: 'session-schema-selection/1.0', writer: 'session/2.0', features: { session_statusless: true } },
    });
    new SessionStore(projectRoot).createSession('legacy-v20', 'statusless compatibility');
    rmSync(join(store.sessionDir('legacy-v20'), '.compat'), { recursive: true, force: true });
    writeV3Session(projectRoot);
    const mismatchDir = writeV3Session(projectRoot, 'mismatch');
    const record = JSON.parse(readFileSync(join(mismatchDir, 'session.json'), 'utf8'));
    writeJson(join(mismatchDir, 'session.json'), { ...record, session_id: 'somewhere-else' });
    const invalidV3Dir = writeV3Session(projectRoot, 'invalid-v3');
    const invalidV3 = JSON.parse(readFileSync(join(invalidV3Dir, 'session.json'), 'utf8'));
    writeJson(join(invalidV3Dir, 'session.json'), { ...invalidV3, objective: 42 });
    const corruptDir = join(store.sessionsRoot, 'corrupt');
    mkdirSync(corruptDir);
    writeFileSync(join(corruptDir, 'session.json'), '{}\n');
    const before = snapshot(projectRoot);

    const listed = store.listSessionRecordsReadOnly();
    expect(listed.candidates.map(item => [item.sessionId, item.session.schema_version])).toEqual([
      ['legacy-v13', 'session/1.3'], ['legacy-v20', 'session/2.0'], ['v3-session', 'session/3.0'],
    ]);
    expect(listed.exclusions).toEqual([
      expect.objectContaining({ sessionId: 'corrupt', code: 'CORRUPT' }),
      expect.objectContaining({ sessionId: 'invalid-v3', code: 'CORRUPT' }),
      expect.objectContaining({ sessionId: 'mismatch', code: 'CORRUPT', detail: expect.stringContaining('identity') }),
    ]);
    const report = await auditKnowledge(projectRoot);
    expect(report.pipeline.sessions).toBe(6);
    expect(report.findings.filter(item => item.subtype === 'invalid-session-authority').map(item => item.target))
      .toEqual(['corrupt', 'invalid-v3', 'mismatch']);
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it.each(['run', 'session'] as const)('diagnoses a corrupt v3 %s ledger without repairing it', async origin => {
    const projectRoot = root();
    const sessionDir = writeV3Session(projectRoot);
    const dir = origin === 'run' ? writeV3Run(sessionDir, 'v3-session', 'run-a') : sessionDir;
    writeFileSync(join(dir, 'knowledge-delta.json'), '{}\n');
    const before = snapshot(projectRoot);
    const report = await auditKnowledge(projectRoot);
    expect(report.findings).toContainEqual(expect.objectContaining({
      subtype: 'invalid-knowledge-ledger', target: 'v3-session',
    }));
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it('keeps the default audit read-only and exposes deterministic lifecycle repair', async () => {
    const projectRoot = root();
    const specPath = writeUnsynchronizedChain(projectRoot);

    const report = await auditKnowledge(projectRoot, { scope: 'spec' });
    expect(report.findings).toContainEqual(expect.objectContaining({
      subtype: 'unsynchronized-supersession',
      target: 'S-old',
      recommended_action: 'deprecate',
    }));
    expect(report.prune_plan).toEqual([]);
    expect(readFileSync(specPath, 'utf8')).not.toContain('sid="S-old" title="Old store rule" status="deprecated"');

    const planned = await auditKnowledge(projectRoot, { scope: 'spec', prune: true });
    expect(planned.prune_plan).toEqual([
      expect.objectContaining({
        action: 'deprecate',
        target_id: 'S-old',
        successor_id: 'S-new',
      }),
    ]);
    expect(readFileSync(specPath, 'utf8')).not.toContain('sid="S-old" title="Old store rule" status="deprecated"');
  });

  it('declares that usage signals cannot independently trigger pruning', async () => {
    const projectRoot = root();
    const report = await auditKnowledge(projectRoot, { scope: 'all', prune: true });
    expect(report.safety).toEqual({
      usage_only_never_pruned: true,
      physical_delete: false,
      diagnostics_read_only: true,
      normalization_requires_prior_report: true,
    });
    expect(report.prune_plan.every(action => action.reason === 'unsynchronized-supersession'))
      .toBe(true);
    expect(existsSync(join(projectRoot, '.workflow', 'sessions'))).toBe(false);
  });

  it('soft-prunes exact spec duplicates with a deterministic canonical successor', async () => {
    const projectRoot = root();
    const dir = join(projectRoot, '.workflow', 'specs');
    mkdirSync(dir, { recursive: true });
    const specPath = join(dir, 'coding-conventions.md');
    writeFileSync(specPath, `---
category: coding
---

<spec-entry category="coding" keywords="store" date="2026-07-01" sid="S-a" title="Store rule">

### Store rule

Use one transaction.

</spec-entry>

<spec-entry category="coding" keywords="store" date="2026-07-02" sid="S-b" title="Store rule">

### Store rule

Use one transaction.

</spec-entry>
`, 'utf8');

    const before = readFileSync(specPath, 'utf8');
    const planned = await auditKnowledge(projectRoot, { scope: 'spec', prune: true });
    expect(planned.prune_plan).toEqual([
      expect.objectContaining({
        store: 'spec',
        target_id: 'S-b',
        successor_id: 'S-a',
        reason: 'exact-duplicate',
      }),
    ]);
    expect(readFileSync(specPath, 'utf8')).toBe(before);
  });

  it('soft-prunes exact knowhow duplicates through the lifecycle supersession API', async () => {
    const projectRoot = root();
    const dir = join(projectRoot, '.workflow', 'knowhow');
    mkdirSync(dir, { recursive: true });
    const body = (title: string) => `---
title: ${title}
type: tip
status: active
---

Use bounded semantic neighborhoods.
`;
    const canonical = join(dir, 'TIP-20260728-a.md');
    const duplicate = join(dir, 'TIP-20260728-b.md');
    writeFileSync(canonical, body('Search diversity'), 'utf8');
    writeFileSync(duplicate, body('Search diversity'), 'utf8');

    const canonicalBefore = readFileSync(canonical, 'utf8');
    const duplicateBefore = readFileSync(duplicate, 'utf8');
    const planned = await auditKnowledge(projectRoot, { scope: 'knowhow', prune: true });
    expect(planned.prune_plan).toEqual([
      expect.objectContaining({
        store: 'knowhow',
        target_id: 'knowhow-tip-20260728-b',
        successor_id: 'knowhow-tip-20260728-a',
        reason: 'exact-duplicate',
      }),
    ]);
    expect(readFileSync(canonical, 'utf8')).toBe(canonicalBefore);
    expect(readFileSync(duplicate, 'utf8')).toBe(duplicateBefore);
  });

  it('prefers canonical Knowhow lifecycle and related paths over conflicting legacy aliases', async () => {
    const projectRoot = root();
    const dir = join(projectRoot, '.workflow', 'knowhow');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'TIP-20260728-canonical.md');
    writeFileSync(path, `---
title: Canonical metadata
type: tip
lifecycleStatus: deprecated
status: active
relatedPaths:
  - src/existing.ts
codePaths:
  - src/missing.ts
---

Canonical fields win.
`, 'utf8');
    writeFileSync(join(projectRoot, 'src', 'existing.ts'), '', 'utf8');

    const report = await auditKnowledge(projectRoot, { scope: 'knowhow' });
    expect(report.knowhow).toMatchObject({ active: 0, deprecated: 1 });
    expect(report.findings).not.toContainEqual(expect.objectContaining({
      subtype: 'ghost-code-reference',
      evidence: expect.stringContaining('src/missing.ts'),
    }));
    expect(readFileSync(path, 'utf8')).toContain('status: active');
  });

  it('reports corrupt Session authority instead of returning a clean pipeline', async () => {
    const projectRoot = root();
    const sessionDir = join(projectRoot, '.workflow', 'sessions', 'corrupt-session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), '{}\n', 'utf8');

    const report = await auditKnowledge(projectRoot, { scope: 'all' });
    expect(report.findings).toContainEqual(expect.objectContaining({
      store: 'pipeline',
      priority: 'P1',
      subtype: 'invalid-session-authority',
      target: 'corrupt-session',
    }));
  });

  it('reports an invalid knowledge ledger instead of swallowing it', async () => {
    const projectRoot = root();
    installCommand(projectRoot);
    const created = createRun({
      projectRoot,
      command: 'audit-demo',
      sessionId: 'ledger-session',
      intent: 'audit invalid ledger',
    });
    writeFileSync(
      join(
        projectRoot,
        '.workflow',
        'sessions',
        created.session_id,
        'runs',
        created.run_id,
        'knowledge-delta.json',
      ),
      '{}\n',
      'utf8',
    );

    const report = await auditKnowledge(projectRoot, { scope: 'all' });
    const finding = report.findings.find(item => item.subtype === 'invalid-knowledge-ledger');
    expect(finding).toEqual(expect.objectContaining({
      store: 'pipeline',
      priority: 'P1',
      subtype: 'invalid-knowledge-ledger',
      target: created.session_id,
    }));
    expect(finding!.evidence.length).toBeLessThan(500);
    expect(finding!.evidence).toContain('schema_version');
  });
});
