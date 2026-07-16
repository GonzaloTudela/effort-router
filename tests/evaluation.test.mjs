import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { aggregateActorRuns, runEvaluationCase } from '../src/evaluation/runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

function resolvePointer(document, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .reduce((value, segment) => value[segment.replaceAll('~1', '/').replaceAll('~0', '~')], document);
}

test('evaluation runner keeps Critic and Actor measurements separate', async () => {
  const evaluationCase = await readJson('evaluation/cases/pure-body.json');
  evaluationCase.repetitions = 2;
  evaluationCase.candidate_routes = evaluationCase.candidate_routes.slice(0, 2);
  const result = await runEvaluationCase(evaluationCase, {
    loadTaskProfile: async (profilePath, pointer) => resolvePointer(await readJson(profilePath), pointer),
    runCritic: async ({ repetition }) => ({
      schema_valid: true,
      reference_fields_matched: repetition === 0,
      claim_references_valid: true,
      latency_ms: 10 + repetition,
      usage: null,
      version: 'critic-test-1'
    }),
    runActor: async ({ candidate, repetition }) => ({
      acceptance_passed: true,
      tests_passed: true,
      scope_violations: 0,
      human_corrections: candidate.model === 'claude-sonnet-5' && repetition === 1 ? 1 : 0,
      latency_ms: candidate.model === 'claude-haiku-4-5' ? 20 : 40,
      cost_units: candidate.model === 'claude-haiku-4-5' ? 1 : 2,
      usage: null,
      version: 'actor-test-1'
    })
  });

  assert.equal(result.critic_runs.length, 2);
  assert.equal(result.actor_runs.length, 4);
  assert.equal(result.critic_runs[1].reference_fields_matched, false);
  assert.equal(Object.hasOwn(result, 'task_text'), false);

  const records = aggregateActorRuns(result, 'feature:test');
  const haiku = records.find(({ model }) => model === 'claude-haiku-4-5');
  const sonnet = records.find(({ model }) => model === 'claude-sonnet-5');
  assert.deepEqual(
    { attempts: haiku.attempts, successes: haiku.successes, latency: haiku.median_latency_ms },
    { attempts: 2, successes: 2, latency: 20 }
  );
  assert.deepEqual(
    { attempts: sonnet.attempts, successes: sonnet.successes, cost: sonnet.median_cost_units },
    { attempts: 2, successes: 1, cost: 2 }
  );
});

test('a run succeeds only when acceptance, tests, scope, and corrections all pass', () => {
  const base = {
    repetition: 0,
    model: 'model',
    effort: null,
    acceptance_passed: true,
    tests_passed: true,
    scope_violations: 0,
    human_corrections: 0,
    latency_ms: null,
    cost_units: null,
    usage: null,
    version: 'test'
  };
  const result = {
    case_id: 'strict-success',
    actor_runs: [
      base,
      { ...base, repetition: 1, acceptance_passed: false },
      { ...base, repetition: 2, tests_passed: false },
      { ...base, repetition: 3, scope_violations: 1 },
      { ...base, repetition: 4, human_corrections: 1 }
    ]
  };
  const [record] = aggregateActorRuns(result, 'feature:strict');
  assert.equal(record.attempts, 5);
  assert.equal(record.successes, 1);
  assert.equal(record.median_latency_ms, null);
});