import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

test('generated docs, skill, bundle, and public versions are synchronized', async () => {
  for (const [script, args] of [
    ['scripts/generate.mjs', ['--check']],
    ['scripts/build.mjs', ['--check']]
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const packageJson = await readJson('package.json');
  const plugin = await readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.version, packageJson.version);

  const skill = await readFile(path.join(root, 'skills', 'effort-router', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('STAGE: TASK_NORMALIZATION'));
  assert.ok(skill.includes('STAGE: SLICE_ASSESSMENT'));
  assert.ok(skill.includes('--spec task.json'));
  assert.doesNotMatch(skill, /complexity_score|recommended_model|recommended_effort|requires_human/);
});

test('bundle runs without node_modules when canonical runtime assets are packaged', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'effort-router-bundle-'));
  try {
    await mkdir(path.join(temporaryRoot, 'dist'), { recursive: true });
    await cp(path.join(root, 'dist', 'analyzer.mjs'), path.join(temporaryRoot, 'dist', 'analyzer.mjs'));
    for (const directory of ['schemas', 'rules', 'policy', 'evaluation']) {
      await cp(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
    }
    const version = spawnSync(process.execPath, ['dist/analyzer.mjs', 'version'], {
      cwd: temporaryRoot,
      encoding: 'utf8'
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), '1.0.0');

    const fixture = await readJson('A-prompt/fixtures/score1_pure.expected.json');
    const source = await readFile(path.join(root, fixture.source), 'utf8');
    const analyzed = spawnSync(process.execPath, ['dist/analyzer.mjs', 'analyze'], {
      cwd: temporaryRoot,
      input: JSON.stringify({
        root: temporaryRoot,
        task_profile: fixture.task,
        files: [{ path: fixture.source, source }]
      }),
      encoding: 'utf8'
    });
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.ok(JSON.parse(analyzed.stdout).code_profile.symbols.length > 0);

    const versions = {
      prompt: '1.0.0',
      task_schema: '1.0.0',
      code_schema: '1.0.0',
      semantic_schema: '1.0.0',
      match_schema: '1.0.0',
      route_schema: '1.0.0',
      policy: '1.0.0',
      model_catalog: '1.0.0',
      analyzer: '1.0.0'
    };
    const recorded = spawnSync(process.execPath, ['dist/analyzer.mjs', 'record'], {
      cwd: temporaryRoot,
      input: JSON.stringify({
        task_profile: { id: 'task:bundle', description: 'private task text' },
        code_profile: { profile_id: 'code:bundle', source_hash: 'a'.repeat(64) },
        semantic_assessment: { assessment_id: 'semantic:bundle' },
        match_profile: { match_id: 'match:bundle' },
        route_decision: {
          decision_id: 'decision:bundle',
          action: 'dispatch',
          selected_candidate: { model: 'model', effort: null },
          versions
        },
        outcome: {
          acceptance: [{ kind: 'test', passed: true }],
          tests_passed: true,
          scope_violations: 0,
          human_corrections: 0
        },
        recorded_at: '2026-07-16T10:00:00.000Z'
      }),
      encoding: 'utf8'
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    const record = JSON.parse(recorded.stdout);
    assert.equal(record.outcome.success, true);
    assert.doesNotMatch(recorded.stdout, /private task text/);

    const metrics = spawnSync(process.execPath, ['dist/analyzer.mjs', 'metrics'], {
      cwd: temporaryRoot,
      input: JSON.stringify({
        records: [record],
        dataset_version: 'bundle-metrics-1.0.0',
        split: 'calibration',
        generated_at: '2026-07-16T10:01:00.000Z'
      }),
      encoding: 'utf8'
    });
    assert.equal(metrics.status, 0, metrics.stderr);
    assert.equal(JSON.parse(metrics.stdout).routes[0].sample_size, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});