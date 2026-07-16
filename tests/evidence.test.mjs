import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createContractValidator } from '../src/contracts/validator.mjs';
import { summarizeExecutionRecords } from '../src/evaluation/metrics.mjs';
import { evaluatePromotion } from '../src/evaluation/promotion.mjs';
import { appendExecutionRecord, createExecutionRecord } from '../src/evaluation/records.mjs';

const contracts = await createContractValidator();
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

function createRecord(overrides = {}) {
  return createExecutionRecord({
    taskProfile: {
      id: 'task:privacy',
      description: 'SECRET_SOURCE_TEXT must never be stored.'
    },
    codeProfile: {
      profile_id: 'code:privacy',
      source_hash: 'a'.repeat(64),
      source: 'SECRET_SOURCE_TEXT'
    },
    semanticAssessment: {
      assessment_id: 'semantic:privacy',
      normalized_task: 'SECRET_SOURCE_TEXT'
    },
    matchProfile: {
      match_id: 'match:privacy',
      evidence: ['SECRET_SOURCE_TEXT']
    },
    routeDecision: {
      decision_id: 'decision:privacy',
      action: 'dispatch',
      selected_candidate: { model: 'model-a', effort: 'medium' },
      versions
    },
    acceptance: [{ kind: 'test', passed: true }],
    testsPassed: true,
    scopeViolations: 0,
    humanCorrections: 0,
    latencyMs: { critic: 10, analysis: 5, actor: 20, total: 35 },
    usage: { input_tokens: 100, output_tokens: 20 },
    recordedAt: '2026-07-16T10:00:00.000Z',
    ...overrides
  });
}

test('execution records contain hashes and outcomes but no source, task text, or secrets', async () => {
  const record = createRecord();
  contracts.validate('execution-record', record);
  assert.equal(record.outcome.success, true);
  assert.equal(record.privacy.source_stored, false);
  assert.doesNotMatch(JSON.stringify(record), /SECRET_SOURCE_TEXT/);
  assert.match(record.hashes.task, /^[a-f0-9]{64}$/);

  const duplicate = createRecord();
  assert.deepEqual(duplicate, record);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'effort-router-record-'));
  try {
    const output = path.join(temporaryDirectory, 'records.jsonl');
    await appendExecutionRecord(output, record);
    const lines = (await readFile(output, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), record);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('success requires acceptance, tests, scope, and zero human corrections', () => {
  const corrected = createRecord({ humanCorrections: 1 });
  const failedTests = createRecord({ testsPassed: false });
  const noAcceptance = createRecord({ acceptance: [] });
  assert.equal(corrected.outcome.success, false);
  assert.equal(failedTests.outcome.success, false);
  assert.equal(noAcceptance.outcome.success, false);
});

test('metrics publish sample sizes, conservative bounds, corrections, scope, and latency', () => {
  const success = createRecord();
  const corrected = createRecord({
    humanCorrections: 1,
    scopeViolations: 1,
    latencyMs: { total: 45 },
    recordedAt: '2026-07-16T10:01:00.000Z'
  });
  const report = summarizeExecutionRecords([success, corrected], {
    datasetVersion: 'test-metrics-1.0.0',
    split: 'retained',
    generatedAt: '2026-07-16T10:02:00.000Z'
  });
  contracts.validate('metrics-report', report);
  assert.equal(report.total_records, 2);
  assert.equal(report.routes[0].sample_size, 2);
  assert.equal(report.routes[0].successes, 1);
  assert.equal(report.routes[0].success_rate, 0.5);
  assert.ok(report.routes[0].success_lower_bound < report.routes[0].success_rate);
  assert.equal(report.routes[0].correction_rate, 0.5);
  assert.equal(report.routes[0].scope_violation_rate, 0.5);
  assert.equal(report.routes[0].median_latency_ms, 40);
});

test('promotion and Rust remain no-go until every retained and profiling gate passes', async () => {
  const gates = JSON.parse(await readFile('policy/promotion-gates.json', 'utf8'));
  const noGo = evaluatePromotion({
    safety: { unsafe_auto_routes: 0, determinism_rate: 1, schema_compliance: 1 },
    retained: {
      sample_size: 0,
      baseline_success_rate: 0,
      current_success_rate: 0,
      baseline_correction_rate: 0,
      current_correction_rate: 0
    },
    profiling: {
      repositories: 1,
      php_files: 3,
      analyzer_latency_share: null,
      measured_speedup: null,
      byte_compatible_json: false
    }
  }, gates);
  assert.equal(noGo.prompt_policy_promotion.approved, false);
  assert.equal(noGo.rust.approved, false);

  const approved = evaluatePromotion({
    safety: { unsafe_auto_routes: 0, determinism_rate: 1, schema_compliance: 1 },
    retained: {
      sample_size: 30,
      baseline_success_rate: 0.95,
      current_success_rate: 0.95,
      baseline_correction_rate: 0.02,
      current_correction_rate: 0.02
    },
    profiling: {
      repositories: 5,
      php_files: 10000,
      analyzer_latency_share: 0.5,
      measured_speedup: 2,
      byte_compatible_json: true
    }
  }, gates);
  assert.equal(approved.prompt_policy_promotion.approved, true);
  assert.equal(approved.rust.approved, true);
});