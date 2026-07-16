import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildActorPayload } from '../src/plugin/actor-payload.mjs';
import { buildTaskDag, executeTaskDag, PlanValidationError } from '../src/plans/dag.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

const fixture = await readJson('A-prompt/fixtures/score1_pure.expected.json');

function task(id, targetPath, dependencies = [], conflictKeys = []) {
  const value = clone(fixture.task);
  value.id = id;
  value.description = `Task ${id}`;
  value.targets = [{ path: targetPath, symbol: `symbol_${id}` }];
  value.context_roots = [targetPath];
  value.dependencies = dependencies;
  value.conflict_keys = conflictKeys;
  value.field_provenance = {
    targets: { source: 'spec', confidence: 1, evidence_refs: [`task:${id}`] }
  };
  return value;
}

function decision(taskId, action = 'dispatch') {
  return {
    task_id: taskId,
    action,
    selected_candidate: action === 'dispatch' ? { model: 'model', effort: null } : null
  };
}

test('DAG schedules independent tasks together and serializes shared resources', () => {
  const independent = buildTaskDag([
    task('a', 'src/a.php'),
    task('b', 'src/b.php'),
    task('c', 'src/c.php', ['a'])
  ]);
  assert.deepEqual(independent.waves, [['a', 'b'], ['c']]);

  const conflicting = buildTaskDag([
    task('a', 'src/shared.php', [], ['resource:cache']),
    task('b', 'src/other.php', [], ['resource:cache'])
  ]);
  assert.deepEqual(conflicting.waves, [['a'], ['b']]);
  assert.deepEqual(conflicting.conflicts[0].resources, ['resource:cache']);
});

test('DAG rejects duplicate IDs, missing dependencies, and cycles', () => {
  assert.throws(() => buildTaskDag([
    task('same', 'src/a.php'),
    task('same', 'src/b.php')
  ]), PlanValidationError);
  assert.throws(() => buildTaskDag([
    task('a', 'src/a.php', ['missing'])
  ]), PlanValidationError);
  assert.throws(() => buildTaskDag([
    task('a', 'src/a.php', ['b']),
    task('b', 'src/b.php', ['a'])
  ]), PlanValidationError);
});

test('blocked tasks stop only their dependents while independent branches execute', async () => {
  const dag = buildTaskDag([
    task('blocked-root', 'src/a.php'),
    task('blocked-child', 'src/b.php', ['blocked-root']),
    task('independent', 'src/c.php')
  ]);
  const executed = [];
  const results = await executeTaskDag(dag, [
    decision('blocked-root', 'human_review'),
    decision('blocked-child'),
    decision('independent')
  ], async (taskId) => {
    executed.push(taskId);
    return { ok: true };
  });
  assert.deepEqual(executed, ['independent']);
  assert.equal(results.find(({ task_id }) => task_id === 'blocked-root').status, 'blocked');
  assert.deepEqual(
    results.find(({ task_id }) => task_id === 'blocked-child').blocked_by,
    ['blocked-root']
  );
  assert.equal(results.find(({ task_id }) => task_id === 'independent').status, 'completed');
});

test('Actor payload includes validated context and rejects non-dispatch actions', () => {
  const routeDecision = {
    action: 'dispatch',
    selected_candidate: { model: 'claude-haiku-4-5', effort: null },
    trigger_evidence_refs: ['static:evidence']
  };
  const payload = buildActorPayload({
    taskProfile: fixture.task,
    semanticAssessment: { assessment_id: 'semantic:test', invariants: ['preserve output'] },
    impactSlice: { code_profile: { evidence: [{ id: 'static:evidence' }] } },
    matchProfile: {
      evidence: [{ id: 'static:evidence', detail: 'static fact' }],
      testability: { commands: ['npm test'] }
    },
    routeDecision
  });
  assert.equal(payload.model, 'claude-haiku-4-5');
  assert.equal(payload.effort, null);
  assert.ok(payload.prompt.includes('static:evidence'));
  assert.ok(payload.payload.validation_commands.includes('npm test'));

  assert.throws(() => buildActorPayload({
    taskProfile: fixture.task,
    semanticAssessment: {},
    impactSlice: { code_profile: { evidence: [] } },
    matchProfile: { evidence: [], testability: { commands: [] } },
    routeDecision: { action: 'human_review', selected_candidate: null }
  }));
});

test('bundled runtime executes analysis and enforces root confinement', async () => {
  const source = await readFile(path.join(root, fixture.source), 'utf8');
  const request = {
    root,
    task_profile: fixture.task,
    files: [{ path: fixture.source, source }]
  };
  const analyzed = spawnSync(process.execPath, ['dist/analyzer.mjs', 'analyze'], {
    cwd: root,
    input: JSON.stringify(request),
    encoding: 'utf8'
  });
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const output = JSON.parse(analyzed.stdout);
  assert.ok(output.code_profile.symbols.some(({ name }) => name === 'slugify'));
  assert.equal(output.impact_slice.bounded, true);

  const missingTask = clone(fixture.task);
  missingTask.targets = [{ path: 'src/missing.php', symbol: 'missing' }];
  missingTask.context_roots = [];
  const missing = spawnSync(process.execPath, ['dist/analyzer.mjs', 'analyze'], {
    cwd: root,
    input: JSON.stringify({ root, task_profile: missingTask }),
    encoding: 'utf8'
  });
  assert.equal(missing.status, 0, missing.stderr);
  const missingOutput = JSON.parse(missing.stdout);
  assert.equal(missingOutput.impact_slice.bounded, false);
  assert.equal(missingOutput.impact_slice.unresolved_targets[0].reason, 'not_found');

  const escapedTask = clone(fixture.task);
  escapedTask.targets = [{ path: '../outside.php', symbol: 'outside' }];
  escapedTask.context_roots = [];
  const escaped = spawnSync(process.execPath, ['dist/analyzer.mjs', 'analyze'], {
    cwd: root,
    input: JSON.stringify({ root, task_profile: escapedTask }),
    encoding: 'utf8'
  });
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /Path escapes analysis root/);
});