import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanOutputs, validateStrictArtifactContract } from './artifacts.js';
import { resolveCommandSource } from './contract.js';

const roots: string[] = [];

function createRun() {
  const sessionDir = mkdtempSync(join(tmpdir(), 'maestro-team-contract-'));
  const runDir = join(sessionDir, 'runs', 'run-001');
  mkdirSync(join(runDir, 'outputs'), { recursive: true });
  roots.push(sessionDir);
  return { sessionDir, runDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('team skill v3 output contracts', () => {
  it('registers swarm ants separately and requires a typed primary solution', () => {
    const contract = resolveCommandSource(process.cwd(), 'team-swarm').contract;
    const { sessionDir, runDir } = createRun();
    const outputs = join(runDir, 'outputs');
    writeFileSync(join(outputs, 'ant-1-1.json'), JSON.stringify({
      _meta: { kind: 'swarm-ant-result', schema: 'swarm-ant-result/1.0', role: 'evidence' },
      ant_id: 'ANT-1-1',
    }));
    writeFileSync(join(outputs, 'swarm-report.json'), JSON.stringify({
      _meta: { kind: 'swarm-report', schema: 'swarm-report/1.0', role: 'attachment' },
      best: { ant_id: 'ANT-1-1' },
    }));
    const missingPrimary = scanOutputs(runDir, sessionDir, contract);
    validateStrictArtifactContract(runDir, contract, missingPrimary);
    expect(missingPrimary.errors).toContain('Missing required contract v2 output: outputs/best-solution.md');

    writeFileSync(join(outputs, 'best-solution.md'),
      '---\nkind: swarm-best-solution\nschema: swarm-best-solution/1.0\nrole: primary\n---\n# Result\n');
    const complete = scanOutputs(runDir, sessionDir, contract);
    validateStrictArtifactContract(runDir, contract, complete);
    expect(complete.errors).toEqual([]);
    expect(complete.artifacts.map(item => [item.kind, item.role])).toEqual([
      ['swarm-ant-result', 'evidence'],
      ['swarm-best-solution', 'primary'],
      ['swarm-report', 'attachment'],
    ]);
  });

  it.each([
    ['team-issue', 'solutions', 'issue-solutions-collection'],
    ['team-lifecycle-v4', 'plan', 'lifecycle-plan-collection'],
    ['team-review', 'scan', 'review-scan-collection'],
    ['team-testing', 'results', 'testing-results-collection'],
    ['team-arch-opt', 'branches', 'architecture-branches-collection'],
    ['team-perf-opt', 'pipelines', 'performance-pipelines-collection'],
  ])('%s publishes nested %s as an explicit directory collection', (name, directory, kind) => {
    const contract = resolveCommandSource(process.cwd(), name).contract;
    const { sessionDir, runDir } = createRun();
    const nested = join(runDir, 'outputs', directory);
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'sample.json'), JSON.stringify({ value: 1 }));
    const scan = scanOutputs(runDir, sessionDir, contract);
    validateStrictArtifactContract(runDir, contract, scan);
    expect(scan.errors).toEqual([]);
    expect(scan.artifacts).toHaveLength(1);
    expect(scan.artifacts[0]).toMatchObject({ kind, schemaVersion: `${kind}/1.0` });
  });
});
