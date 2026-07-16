import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = path.join(root, 'schemas');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

const schemaFiles = (await readdir(schemaDirectory))
  .filter((name) => name.endsWith('.schema.json'))
  .sort();
const schemas = await Promise.all(schemaFiles.map((name) => readJson(path.join('schemas', name))));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });

for (const schema of schemas) {
  ajv.addSchema(schema);
}

function validator(name) {
  const validate = ajv.getSchema(`https://effort-router.local/schemas/${name}.schema.json`);
  assert.ok(validate, `missing validator for ${name}`);
  return validate;
}

function assertValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function clone(value) {
  return structuredClone(value);
}

const pureExpectation = await readJson('A-prompt/fixtures/score1_pure.expected.json');

test('all schemas compile and expose a stable identifier', () => {
  for (const schema of schemas) {
    assert.match(schema.$id, /^https:\/\/effort-router\.local\/schemas\/.+\.schema\.json$/);
    assert.doesNotThrow(() => ajv.getSchema(schema.$id));
  }
});

test('primary contract versions are pinned to 1.0.0', () => {
  for (const name of [
    'task-profile',
    'semantic-assessment',
    'code-profile',
    'match-profile',
    'route-decision'
  ]) {
    const schema = schemas.find(({ $id }) => $id.endsWith(`/${name}.schema.json`));
    assert.equal(schema.properties.schema_version.const, '1.0.0');
  }
});

test('TaskProfile accepts complete and explicitly incomplete contracts', () => {
  const validate = validator('task-profile');
  assertValid(validate, pureExpectation.task);

  const incomplete = clone(pureExpectation.task);
  incomplete.contract_status = 'incomplete';
  incomplete.targets = [];
  incomplete.acceptance = [];
  incomplete.missing_fields = ['targets', 'acceptance'];
  incomplete.ambiguities = [{
    field: 'targets',
    description: 'No target was supplied.',
    material: true
  }];
  assertValid(validate, incomplete);

  incomplete.contract_status = 'complete';
  assert.equal(validate(incomplete), false);
});

test('TaskProfile rejects a complete contract with a material ambiguity', () => {
  const validate = validator('task-profile');
  const task = clone(pureExpectation.task);
  task.ambiguities.push({
    field: 'change_surface',
    description: 'The requested surface is unclear.',
    material: true
  });
  assert.equal(validate(task), false);
});

test('SemanticAssessment is strict and cannot recommend a route', () => {
  const validate = validator('semantic-assessment');
  const assessment = {
    schema_version: '1.0.0',
    assessment_id: 'assessment:pure',
    task_id: pureExpectation.task.id,
    normalized_task: pureExpectation.task.description,
    ambiguities: [],
    invariants: pureExpectation.expected_semantic.invariants,
    semantic_risks: [{
      kind: 'behavioral_equivalence',
      description: 'Both functions must preserve their current output.',
      evidence_refs: ['task:fixture-pure-body']
    }],
    required_capabilities: ['code_editing', 'php_semantics'],
    required_context: [],
    confidence: { overall: 0.98, task_interpretation: 1, code_alignment: 0.98 },
    claims: [{
      id: 'claim:pure-output',
      kind: 'invariant',
      statement: 'The output must remain deterministic.',
      evidence_ref: 'static:pure-no-effects',
      rationale: 'The static slice contains no external effects.',
      static_check: null
    }]
  };
  assertValid(validate, assessment);

  assessment.recommended_model = 'any-model';
  assert.equal(validate(assessment), false);
});

test('CodeProfile represents raw facts without a route or difficulty score', () => {
  const validate = validator('code-profile');
  const hash = 'a'.repeat(64);
  const profile = {
    schema_version: '1.0.0',
    profile_id: 'code:pure',
    analyzer: {
      name: 'php-static',
      version: '1.0.0',
      language: 'php',
      rule_versions: { 'php-core': '1.0.0' }
    },
    source_hash: hash,
    files: [{
      path: 'A-prompt/fixtures/score1_pure.php',
      hash,
      parsed: true,
      parse_errors: []
    }],
    symbols: [{
      id: 'symbol:slugify',
      kind: 'function',
      name: 'slugify',
      qualified_name: 'slugify',
      location: {
        path: 'A-prompt/fixtures/score1_pure.php',
        start_line: 6,
        end_line: 11,
        start_column: null,
        end_column: null
      },
      signature: 'slugify(string): string',
      parameters: ['text:string'],
      return_types: ['string'],
      control_flow: {
        branch_count: 0,
        loop_count: 0,
        throw_count: 0,
        return_count: 1,
        cyclomatic_complexity: 1
      }
    }],
    calls: [],
    state_accesses: [],
    effects: [],
    dependencies: [],
    tests: [],
    coverage: {
      files_total: 1,
      files_parsed: 1,
      calls_total: 0,
      calls_resolved: 0,
      unresolved_call_ids: [],
      dynamic_constructs: 0,
      bounded: true
    },
    evidence: [{
      id: 'static:pure-no-effects',
      source: 'static',
      kind: 'effect_summary',
      location: null,
      rule_id: null,
      detail: 'No external effects were found in the selected symbol.',
      confidence: 1
    }]
  };
  assertValid(validate, profile);

  profile.complexity_score = 1;
  assert.equal(validate(profile), false);
});

test('MatchProfile preserves dimensions, blockers, and provenance independently', () => {
  const validate = validator('match-profile');
  const evidenceRefs = ['static:pure-no-effects'];
  const profile = {
    schema_version: '1.0.0',
    match_id: 'match:pure',
    task_id: pureExpectation.task.id,
    operation: 'refactor',
    change_surface: 'body',
    code_profile_id: 'code:pure',
    semantic_assessment_id: 'assessment:pure',
    affected_symbols: ['symbol:slugify'],
    affected_files: ['A-prompt/fixtures/score1_pure.php'],
    context_estimate: { file_count: 1, symbol_count: 1, estimated_tokens: 80, bounded: true },
    intrinsic_complexity: { level: 'low', evidence_refs: evidenceRefs },
    semantic_difficulty: { level: 'low', evidence_refs: ['task:fixture-pure-body'] },
    coupling: { level: 'low', evidence_refs: evidenceRefs },
    effect_kinds: [],
    blast_radius: {
      level: 'low',
      direct_dependents: 0,
      transitive_dependents: 0,
      evidence_refs: evidenceRefs
    },
    testability: {
      level: 'partial',
      commands: ['php -l A-prompt/fixtures/score1_pure.php'],
      evidence_refs: ['task:fixture-pure-body']
    },
    reversibility: { level: 'high', evidence_refs: ['task:fixture-pure-body'] },
    unresolved_calls: [],
    analysis_coverage: { parsed_file_ratio: 1, resolved_call_ratio: 1, bounded: true },
    semantic_confidence: { overall: 0.98, task_interpretation: 1, code_alignment: 0.98 },
    requirements: [{
      id: 'requirement:pure-results',
      source: 'task',
      description: 'Preserve observable results.',
      evidence_refs: ['task:fixture-pure-body']
    }],
    required_capabilities: [{
      capability: 'php_semantics',
      provenance: { source: 'matcher', confidence: 1, evidence_refs: evidenceRefs }
    }],
    blockers: [],
    disagreements: [],
    evidence: [{
      id: 'static:pure-no-effects',
      source: 'static',
      kind: 'effect_summary',
      location: null,
      rule_id: null,
      detail: 'No external effects were found in the selected symbol.',
      confidence: 1
    }]
  };
  assertValid(validate, profile);
  assert.equal(Object.hasOwn(profile, 'score'), false);
});

test('RouteDecision allows a candidate only when dispatching', () => {
  const validate = validator('route-decision');
  const decision = {
    schema_version: '1.0.0',
    decision_id: 'decision:pure',
    task_id: pureExpectation.task.id,
    match_id: 'match:pure',
    mode: 'confirm',
    action: 'dispatch',
    selected_candidate: {
      model: 'catalog-model',
      effort: null,
      context_window: 200000,
      cost_rank: 1,
      latency_rank: 1,
      evidence_refs: ['history:pure-model']
    },
    required_context: [],
    guard_results: [{
      guard: 'contract-complete',
      outcome: 'pass',
      reason: 'The task contract is complete.',
      evidence_refs: ['task:fixture-pure-body']
    }],
    rejected_candidates: [],
    calibration: {
      dataset_version: 'fixture-1.0.0',
      comparable_sample_size: 30,
      success_lower_bound: 0.97,
      quality_target: 0.95
    },
    trigger_evidence_refs: ['task:fixture-pure-body', 'history:pure-model'],
    versions: {
      prompt: '1.0.0',
      task_schema: '1.0.0',
      code_schema: '1.0.0',
      semantic_schema: '1.0.0',
      match_schema: '1.0.0',
      route_schema: '1.0.0',
      policy: '1.0.0',
      model_catalog: '1.0.0',
      analyzer: '1.0.0'
    }
  };
  assertValid(validate, decision);

  decision.action = 'request_context';
  assert.equal(validate(decision), false);
  decision.selected_candidate = null;
  decision.required_context = ['tests for slugify'];
  assertValid(validate, decision);
});

test('effect catalogs validate, contain unique IDs, and contain no routing weights', async () => {
  const validate = validator('effect-rules');
  const catalogs = await Promise.all([
    readJson('rules/php-core.json'),
    readJson('rules/wordpress.json'),
    readJson('rules/laravel.json')
  ]);
  const ids = [];
  for (const catalog of catalogs) {
    assertValid(validate, catalog);
    ids.push(...catalog.rules.map(({ id }) => id));
    assert.doesNotMatch(JSON.stringify(catalog), /complexity|difficulty|weight|model|effort/i);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('converted fixtures validate and do not encode route conclusions', async () => {
  const validate = validator('fixture-expectation');
  const fixtureNames = [
    'score1_pure.expected.json',
    'score4_wpquery.expected.json',
    'score5_globals.expected.json'
  ];
  for (const fixtureName of fixtureNames) {
    const fixture = await readJson(path.join('A-prompt', 'fixtures', fixtureName));
    assertValid(validate, fixture);
    assert.doesNotMatch(JSON.stringify(fixture), /recommended_model|recommended_effort|complexity_score|requires_human/);
  }
});

test('routing policy, model catalog, calibration sets, and evaluation cases validate', async () => {
  assertValid(validator('model-catalog'), await readJson('policy/model-catalog.json'));
  assertValid(validator('router-policy'), await readJson('policy/router-policy.json'));
  assertValid(
    validator('calibration-results'),
    await readJson('evaluation/results/bootstrap-calibration.json')
  );
  assertValid(
    validator('calibration-results'),
    await readJson('evaluation/results/bootstrap-retained.json')
  );
  for (const caseName of ['pure-body.json', 'wpquery-data-contract.json', 'globals-architecture.json']) {
    assertValid(validator('evaluation-case'), await readJson(path.join('evaluation', 'cases', caseName)));
  }
  assertValid(validator('promotion-gates'), await readJson('policy/promotion-gates.json'));
  assertValid(
    validator('metrics-report'),
    await readJson('evaluation/metrics/bootstrap-calibration.json')
  );
  assertValid(
    validator('metrics-report'),
    await readJson('evaluation/metrics/bootstrap-retained.json')
  );
  assertValid(
    validator('benchmark-report'),
    await readJson('evaluation/benchmarks/local-baseline.json')
  );
  assertValid(
    validator('promotion-decision'),
    await readJson('evaluation/decisions/current.json')
  );
});