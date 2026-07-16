import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { deterministicId, sha256, stableStringify } from '../analyzer/stable.mjs';

function normalizedLatency(value = {}) {
  return {
    critic: value.critic ?? null,
    analysis: value.analysis ?? null,
    actor: value.actor ?? null,
    total: value.total ?? null
  };
}

function normalizedUsage(value = {}) {
  return {
    input_tokens: value.input_tokens ?? null,
    output_tokens: value.output_tokens ?? null,
    cache_read_tokens: value.cache_read_tokens ?? null,
    cache_write_tokens: value.cache_write_tokens ?? null
  };
}

export function createExecutionRecord({
  taskProfile,
  codeProfile,
  semanticAssessment,
  matchProfile,
  routeDecision,
  acceptance = [],
  testsPassed = null,
  scopeViolations = 0,
  humanCorrections = 0,
  latencyMs = {},
  usage = {},
  recordedAt = new Date().toISOString()
}) {
  const success = (
    routeDecision.action === 'dispatch' &&
    acceptance.length > 0 &&
    acceptance.every(({ passed }) => passed) &&
    testsPassed !== false &&
    scopeViolations === 0 &&
    humanCorrections === 0
  );
  const hashes = {
    task: sha256(stableStringify(taskProfile)),
    source: codeProfile.source_hash,
    semantic: sha256(stableStringify(semanticAssessment)),
    match: sha256(stableStringify(matchProfile)),
    route: sha256(stableStringify(routeDecision))
  };
  const selected = routeDecision.selected_candidate;
  return {
    schema_version: '1.0.0',
    record_id: deterministicId(
      'execution',
      taskProfile.id,
      routeDecision.decision_id,
      recordedAt,
      hashes.route
    ),
    recorded_at: recordedAt,
    task_id: taskProfile.id,
    hashes,
    profile_ids: {
      code: codeProfile.profile_id,
      semantic: semanticAssessment.assessment_id,
      match: matchProfile.match_id,
      decision: routeDecision.decision_id
    },
    route: {
      action: routeDecision.action,
      model: selected?.model ?? null,
      effort: selected?.effort ?? null
    },
    versions: routeDecision.versions,
    outcome: {
      acceptance,
      tests_passed: testsPassed,
      scope_violations: scopeViolations,
      human_corrections: humanCorrections,
      success
    },
    latency_ms: normalizedLatency(latencyMs),
    usage: normalizedUsage(usage),
    privacy: {
      source_stored: false,
      secrets_stored: false
    }
  };
}

export async function appendExecutionRecord(outputPath, record) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}