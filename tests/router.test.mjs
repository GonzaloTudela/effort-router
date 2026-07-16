import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzePhpFiles, buildImpactSlice, stableStringify } from '../src/analyzer/index.mjs';
import { ContractValidationError, createContractValidator } from '../src/contracts/validator.mjs';
import { runCriticPipeline } from '../src/critic/pipeline.mjs';
import { reconcileProfiles } from '../src/matcher/reconcile.mjs';
import { loadRoutingAssets } from '../src/router/assets.mjs';
import { calibrationFeatureKey, selectRoute, wilsonLowerBound } from '../src/router/selector.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function clone(value) {
  return structuredClone(value);
}

const contracts = await createContractValidator();
const assets = await loadRoutingAssets();
const fixture = await readJson('A-prompt/fixtures/score1_pure.expected.json');
const codeProfile = await analyzePhpFiles([{
  path: fixture.source,
  source: await readText(fixture.source)
}]);
const impactSlice = buildImpactSlice(fixture.task, codeProfile);
const staticEvidenceRef = impactSlice.code_profile.evidence.find(({ source }) => source === 'static').id;

function semanticAssessment(overrides = {}) {
  return {
    schema_version: '1.0.0',
    assessment_id: 'assessment:pure-route',
    task_id: fixture.task.id,
    normalized_task: fixture.task.description,
    ambiguities: [],
    invariants: fixture.expected_semantic.invariants,
    semantic_risks: [{
      kind: 'behavioral_equivalence',
      description: 'Observable results must remain unchanged.',
      evidence_refs: [`task:${fixture.task.id}`]
    }],
    required_capabilities: ['php_semantics'],
    required_context: [],
    confidence: { overall: 0.98, task_interpretation: 1, code_alignment: 0.98 },
    claims: [{
      id: 'claim:pure-contract',
      kind: 'invariant',
      statement: 'The pure outputs remain unchanged.',
      evidence_ref: `task:${fixture.task.id}`,
      rationale: 'The task explicitly requires behavioral preservation.',
      static_check: null
    }, {
      id: 'claim:no-cache',
      kind: 'code_interpretation',
      statement: 'The slice does not use a cache.',
      evidence_ref: staticEvidenceRef,
      rationale: 'No cache effect is present in the static slice.',
      static_check: { kind: 'effect_presence', subject: 'cache_read', expected: false }
    }],
    ...overrides
  };
}

const assessment = semanticAssessment();
const matchProfile = reconcileProfiles(fixture.task, assessment, impactSlice);

function historyWith(records) {
  return {
    schema_version: '1.0.0',
    dataset_version: 'test-calibration-1.0.0',
    split: 'calibration',
    versions: {
      prompt: '1.0.0',
      policy: assets.policy.policy_version,
      model_catalog: assets.catalog.catalog_version,
      analyzer: '1.0.0'
    },
    records
  };
}

function calibratedRecord(model, effort, attempts, successes, latency, cost) {
  return {
    case_id: `case:${model}:${effort ?? 'none'}`,
    feature_key: calibrationFeatureKey(matchProfile),
    model,
    effort,
    attempts,
    successes,
    median_latency_ms: latency,
    median_cost_units: cost
  };
}

function route(options = {}) {
  return selectRoute({
    taskProfile: fixture.task,
    matchProfile,
    catalog: assets.catalog,
    policy: assets.policy,
    history: assets.history,
    mode: 'confirm',
    ...options
  });
}

test('reconciliation emits a valid MatchProfile with separate dimensions and evidence', () => {
  contracts.validate('semantic-assessment', assessment);
  contracts.validate('match-profile', matchProfile);
  assert.equal(matchProfile.blockers.length, 0);
  assert.equal(matchProfile.disagreements.length, 0);
  assert.equal(Object.hasOwn(matchProfile, 'score'), false);
  assert.deepEqual(
    matchProfile.required_capabilities.map(({ capability }) => capability),
    ['code_editing', 'php_semantics', 'tool_use']
  );
});

test('reconciliation blocks unsupported claims and material static disagreements', () => {
  const unsupported = semanticAssessment({
    claims: [{
      id: 'claim:unsupported',
      kind: 'risk',
      statement: 'An unsupported risk exists.',
      evidence_ref: null,
      rationale: 'No evidence was supplied.',
      static_check: null
    }]
  });
  const unsupportedMatch = reconcileProfiles(fixture.task, unsupported, impactSlice);
  assert.ok(unsupportedMatch.blockers.some(({ kind }) => kind === 'unsupported_claim'));

  const disagreeing = semanticAssessment({
    claims: [{
      id: 'claim:cache-present',
      kind: 'code_interpretation',
      statement: 'The pure slice reads cache state.',
      evidence_ref: staticEvidenceRef,
      rationale: 'This deliberately contradicts the fixture.',
      static_check: { kind: 'effect_presence', subject: 'cache_read', expected: true }
    }]
  });
  const disagreeingMatch = reconcileProfiles(fixture.task, disagreeing, impactSlice);
  assert.equal(disagreeingMatch.disagreements.length, 1);
  assert.ok(disagreeingMatch.blockers.some(({ kind, severity }) => kind === 'disagreement' && severity === 'blocks_dispatch'));
  contracts.validate('match-profile', disagreeingMatch);
});

test('Critic pipeline executes normalization then slice assessment and validates both', async () => {
  const seenStages = [];
  const result = await runCriticPipeline({
    originalTask: fixture.task.description,
    codeProfile,
    executeCritic: async (request) => {
      seenStages.push(request.stage);
      return request.stage === 'TASK_NORMALIZATION' ? fixture.task : assessment;
    },
    validator: contracts
  });
  assert.deepEqual(seenStages, ['TASK_NORMALIZATION', 'SLICE_ASSESSMENT']);
  assert.equal(result.status, 'assessed');
  assert.ok(result.impact_slice.code_profile.symbols.length > 0);
});

test('Critic pipeline stops on an incomplete task and rejects route fields in Critic output', async () => {
  const incomplete = clone(fixture.task);
  incomplete.contract_status = 'incomplete';
  incomplete.missing_fields = ['targets', 'acceptance'];
  incomplete.targets = [];
  incomplete.acceptance = [];
  incomplete.ambiguities = [{ field: 'targets', description: 'Target missing.', material: true }];
  const stopped = await runCriticPipeline({
    originalTask: 'Refactor it.',
    taskProfile: incomplete,
    codeProfile,
    executeCritic: async () => assert.fail('Critic must not assess an incomplete task.'),
    validator: contracts
  });
  assert.equal(stopped.status, 'request_task_contract');

  const invalidAssessment = { ...assessment, recommended_model: 'claude-opus-4-8' };
  await assert.rejects(
    runCriticPipeline({
      originalTask: fixture.task.description,
      taskProfile: fixture.task,
      codeProfile,
      executeCritic: async () => invalidAssessment,
      validator: contracts
    }),
    ContractValidationError
  );
});

test('bootstrap is conservative: confirm dispatches capable route, auto requests review', () => {
  const confirmed = route();
  contracts.validate('route-decision', confirmed);
  assert.equal(confirmed.action, 'dispatch');
  assert.equal(confirmed.selected_candidate.model, 'claude-opus-4-8');
  assert.equal(confirmed.selected_candidate.effort, 'xhigh');
  assert.equal(confirmed.calibration.comparable_sample_size, 0);

  const automatic = route({ mode: 'auto' });
  contracts.validate('route-decision', automatic);
  assert.equal(automatic.action, 'human_review');
  assert.equal(automatic.selected_candidate, null);
});

test('calibrated selection chooses the fastest then least costly route above the quality gate', () => {
  const history = historyWith([
    calibratedRecord('claude-haiku-4-5', null, 100, 100, 10, 1),
    calibratedRecord('claude-opus-4-8', 'xhigh', 100, 100, 40, 5)
  ]);
  const decision = route({ mode: 'auto', history });
  contracts.validate('route-decision', decision);
  assert.equal(decision.action, 'dispatch');
  assert.equal(decision.selected_candidate.model, 'claude-haiku-4-5');
  assert.equal(decision.selected_candidate.effort, null);
  assert.ok(decision.calibration.success_lower_bound >= fixture.task.quality_target);
});

test('insufficient samples never justify a cheaper automatic route', () => {
  const history = historyWith([
    calibratedRecord('claude-haiku-4-5', null, 10, 10, 10, 1)
  ]);
  const decision = route({ mode: 'auto', history });
  assert.equal(decision.action, 'human_review');
  assert.equal(decision.selected_candidate, null);
  assert.equal(decision.calibration.comparable_sample_size, 10);
});

test('stale or internally inconsistent history cannot influence routing', () => {
  const stale = historyWith([
    calibratedRecord('claude-haiku-4-5', null, 100, 100, 10, 1)
  ]);
  stale.versions.prompt = '0.9.0';
  const staleDecision = route({ mode: 'auto', history: stale });
  assert.equal(staleDecision.action, 'human_review');
  assert.equal(staleDecision.calibration.comparable_sample_size, 0);

  const corrupt = historyWith([
    calibratedRecord('claude-haiku-4-5', null, 10, 11, 10, 1)
  ]);
  assert.throws(() => route({ mode: 'auto', history: corrupt }), RangeError);
});

test('guard precedence maps low confidence, missing coverage, unsafe effects, and acceptance to explicit actions', () => {
  const lowConfidence = clone(matchProfile);
  lowConfidence.semantic_confidence = { overall: 0.5, task_interpretation: 0.5, code_alignment: 0.5 };
  assert.equal(route({ matchProfile: lowConfidence, mode: 'auto' }).action, 'escalate_critic');

  const missingCoverage = clone(matchProfile);
  missingCoverage.analysis_coverage.bounded = false;
  assert.equal(route({ matchProfile: missingCoverage, mode: 'auto' }).action, 'request_context');

  const unsafe = clone(matchProfile);
  unsafe.blockers.push({
    kind: 'unresolved_effect',
    severity: 'blocks_dispatch',
    description: 'Dynamic target.',
    evidence_refs: [unsafe.evidence[0].id]
  });
  assert.equal(route({ matchProfile: unsafe, mode: 'confirm' }).action, 'human_review');

  const unexecutable = clone(matchProfile);
  unexecutable.blockers.push({
    kind: 'unexecutable_acceptance',
    severity: 'blocks_auto',
    description: 'Manual check.',
    evidence_refs: [`task:${fixture.task.id}`]
  });
  assert.equal(route({ matchProfile: unexecutable, mode: 'auto' }).action, 'human_review');
});

test('catalog effort support and approvals are deterministic candidate constraints', () => {
  const decision = route();
  assert.ok(decision.rejected_candidates.some(({ model, reasons }) => (
    model === 'claude-fable-5' && reasons.includes('approval_required')
  )));
  assert.equal(
    decision.rejected_candidates.some(({ model, effort }) => model === 'claude-haiku-4-5' && effort !== null),
    false
  );
  assert.ok(decision.rejected_candidates.every(({ reasons }) => reasons.length > 0));
  assert.ok(decision.rejected_candidates.some(({ reasons }) => (
    reasons.some((reason) => reason.startsWith('insufficient_samples:'))
  )));
});

test('Wilson bound and decisions are deterministic for identical validated inputs', () => {
  assert.ok(wilsonLowerBound(100, 100) > wilsonLowerBound(10, 10));
  const first = route();
  const second = route();
  assert.equal(stableStringify(first), stableStringify(second));
});