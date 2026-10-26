import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();
const rolePath = join(repoRoot, '.claude', 'skills', 'team-swarm', 'roles', 'coordinator', 'role.md');
const initPath = join(repoRoot, '.claude', 'skills', 'team-swarm', 'roles', 'coordinator', 'commands', 'init-swarm.md');

test('team-swarm Phase 0 uses exact Run ownership and explicit locator-less selection', () => {
  const role = readFileSync(rolePath, 'utf8');

  assert.match(role, /Exact Run locator first/);
  assert.match(role, /exact `run_dir` contains at most one team session/);
  assert.match(role, /Never select candidate index 0 implicitly/);
  assert.match(role, /canonical Run status, broker-backed live agents, non-terminal team tasks/);
  assert.doesNotMatch(role, /Single session -> resume; multiple -> AskUserQuestion/);
});

test('team-swarm prompt keeps stale health, abandonment, and cleanup separate', () => {
  const role = readFileSync(rolePath, 'utf8');
  const init = readFileSync(initPath, 'utf8');

  assert.match(role, /`stale_candidate` is derived health, never a lifecycle and never cleanup eligibility/);
  assert.match(role, /Abandonment and cleanup are separate confirmed operations/);
  assert.match(role, /never `run\.json`, `outputs\/`/);
  assert.match(init, /Do not offer a generic "clean or resume" action/);
  assert.match(init, /`abandoned` requires a separate explicit audited transition/);
  assert.match(init, /cleanup requires a second confirmation/);
  assert.doesNotMatch(init, /prompt to clean or resume/);
});

test('team skills use Run brief for continuation and declare nested output collections', () => {
  for (const name of ['team-arch-opt', 'team-coordinate', 'team-issue', 'team-lifecycle-v4',
    'team-perf-opt', 'team-review', 'team-swarm', 'team-testing']) {
    const role = readFileSync(join(repoRoot, '.claude', 'skills', name, 'roles', 'coordinator', 'role.md'), 'utf8');
    assert.match(role, /maestro run brief <run_id> --session <session_id> --json/);
    assert.match(role, /before any Run-scoped directory|before any Run-scoped file write/);
    assert.match(role, /"run": \{ "session_id": "<canonical-session-id>", "run_id": "<id>", "run_dir": "<path>" \}/);
    assert.doesNotMatch(role, /run check <run_id>[^\n]*receipt's structured `continuation`/);
  }
  for (const name of ['team-arch-opt', 'team-issue', 'team-lifecycle-v4',
    'team-perf-opt', 'team-review', 'team-swarm', 'team-testing']) {
    const skill = readFileSync(join(repoRoot, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, /contract_version: 2\.1/);
    assert.match(skill, /path: outputs\//);
  }
});

test('team-swarm Run outputs have a typed primary, report, and ant contract', () => {
  const skill = readFileSync(join(repoRoot, '.claude', 'skills', 'team-swarm', 'SKILL.md'), 'utf8');
  const analyst = readFileSync(join(repoRoot, '.claude', 'skills', 'team-swarm', 'roles', 'analyst', 'role.md'), 'utf8');
  const converge = readFileSync(join(repoRoot, '.claude', 'skills', 'team-swarm', 'roles', 'coordinator', 'commands', 'converge.md'), 'utf8');
  const init = readFileSync(initPath, 'utf8');
  assert.match(skill, /path: outputs\/best-solution\.md, kind: swarm-best-solution, schema: swarm-best-solution\/1\.0, role: primary, required: true/);
  assert.match(skill, /outputs\/ant-\{iteration\}-\{ant_id\}\.json/);
  assert.match(analyst, /kind: swarm-best-solution\nschema: swarm-best-solution\/1\.0\nrole: primary/);
  assert.match(converge, /including `_meta`/);
  assert.match(converge, /Do not substitute an untyped manual report/);
  assert.match(init, /session_path = Path\(run_dir\) \/ "work" \/ "team"/);
  assert.match(init, /Perform the coordinator role's \*\*Run Lifecycle Integration\*\* before creating/);
});

test('shared recovery reads continuation from brief and completes Session before closeout', () => {
  const guide = readFileSync(join(repoRoot, 'workflows', 'run-mode-lite.md'), 'utf8');
  assert.match(guide, /run check <run_id> --session \{session_id\} --json` for blockers/);
  assert.match(guide, /run brief <run_id> --session \{session_id\} --json` for structured `continuation`/);
  assert.match(guide, /Apply only the brief's continuation/);
  const completeSection = guide.slice(guide.indexOf('## Complete'));
  assert.ok(completeSection.indexOf('maestro session complete') < completeSection.indexOf('After terminal Session completion is verified'));
  assert.doesNotMatch(guide, /re-reading status\/revision if needed after closeout/);
});

test('swarm follow-up allocates a fresh Run and preserves sealed coordination state', () => {
  const converge = readFileSync(join(repoRoot, '.claude', 'skills', 'team-swarm', 'roles', 'coordinator', 'commands', 'converge.md'), 'utf8');
  assert.match(converge, /Before requesting completion, merge-write team status="completed"/);
  assert.match(converge, /After sealing,[^\n]*do not update team-session\.json/);
  assert.match(converge, /wait for a new birth packet/);
  assert.match(converge, /prior Session is terminal\/completed, open a new Session/);
  assert.match(converge, /distinct new `session_id` \/ `run_id` \/ `run_dir` before any follow-up write/);
  assert.match(converge, /Do not copy old outputs, trails, scores/);
  assert.doesNotMatch(converge, /reset convergence counters; re-enter Phase 3/);
  assert.doesNotMatch(converge, /\| Keep Active \| session\.status/);
});

test('TeamCreate conflict recovery resumes only the verified exact matching session', () => {
  const init = readFileSync(initPath, 'utf8');

  assert.match(init, /Resolve the exact `run_id` \/ `run_dir`/);
  assert.match(init, /offer resume only if lifecycle reconciliation verifies a matching active\/paused `team-swarm` session/);
  assert.match(init, /must never choose array index 0 implicitly/);
  assert.match(init, /"updated_at": "<iso8601>"/);
  assert.match(init, /"run": \{ "session_id": "<canonical-session-id>", "run_id": "<run-id>", "run_dir": "<run-dir>" \}/);
});
