import { deterministicId } from '../analyzer/stable.mjs';

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function makeEvidence({ id, source, kind, detail, ruleId = null, confidence = 1, location = null }) {
  return { id, source, kind, location, rule_id: ruleId, detail, confidence };
}

function evaluateStaticCheck(check, codeProfile) {
  if (check.kind === 'effect_presence') {
    return codeProfile.effects.some(({ kind, operation }) => kind === check.subject || operation === check.subject);
  }
  if (check.kind === 'call_resolution') {
    return codeProfile.calls.some(({ callee, resolved }) => callee === check.subject && resolved);
  }
  if (check.kind === 'state_access_presence') {
    return codeProfile.state_accesses.some(({ subject }) => subject === check.subject);
  }
  if (check.kind === 'coverage_bounded') {
    return codeProfile.coverage.bounded;
  }
  if (check.kind === 'symbol_presence') {
    return codeProfile.symbols.some(({ name, qualified_name }) => (
      name === check.subject || qualified_name === check.subject
    ));
  }
  return false;
}

function categoryLevel(value, moderateThreshold, highThreshold) {
  if (value >= highThreshold) {
    return 'high';
  }
  if (value >= moderateThreshold) {
    return 'moderate';
  }
  return 'low';
}

export function reconcileProfiles(taskProfile, semanticAssessment, impactSlice) {
  const codeProfile = impactSlice.code_profile;
  const evidence = [...codeProfile.evidence];
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  const staticEvidenceIds = new Set(evidenceIds);

  function addEvidence(item) {
    if (!evidenceIds.has(item.id)) {
      evidenceIds.add(item.id);
      evidence.push(item);
    }
    return item.id;
  }

  const taskEvidenceRefs = new Set([`task:${taskProfile.id}`]);
  for (const provenance of Object.values(taskProfile.field_provenance)) {
    for (const reference of provenance.evidence_refs) {
      taskEvidenceRefs.add(reference);
    }
  }
  for (const reference of taskEvidenceRefs) {
    addEvidence(makeEvidence({
      id: reference,
      source: 'task',
      kind: 'task_contract',
      detail: taskProfile.description
    }));
  }

  for (const claim of semanticAssessment.claims) {
    addEvidence(makeEvidence({
      id: claim.id,
      source: 'semantic',
      kind: claim.kind,
      detail: claim.statement,
      confidence: semanticAssessment.confidence.overall
    }));
  }

  function policyEvidence(kind, detail, sourceRefs = []) {
    return addEvidence(makeEvidence({
      id: deterministicId('evidence', 'matcher', kind, detail, ...sourceRefs),
      source: 'policy',
      kind,
      detail,
      ruleId: `matcher.${kind}.v1`
    }));
  }

  const staticFallbackRef = codeProfile.evidence[0]?.id ?? policyEvidence(
    'static_summary',
    'The selected static slice contains no location-specific evidence.'
  );
  const blockers = [];
  const disagreements = [];
  const knownInputEvidence = new Set([...staticEvidenceIds, ...taskEvidenceRefs]);

  if (taskProfile.contract_status !== 'complete') {
    blockers.push({
      kind: 'contract_incomplete',
      severity: 'blocks_dispatch',
      description: `Missing task fields: ${taskProfile.missing_fields.join(', ')}`,
      evidence_refs: [`task:${taskProfile.id}`]
    });
  }
  if (codeProfile.files.some(({ parsed }) => !parsed)) {
    blockers.push({
      kind: 'parse_failure',
      severity: 'blocks_dispatch',
      description: 'At least one selected file did not parse successfully.',
      evidence_refs: codeProfile.evidence.filter(({ kind }) => kind === 'parse_error').map(({ id }) => id)
    });
  }
  if (!impactSlice.bounded) {
    blockers.push({
      kind: 'unbounded_slice',
      severity: 'blocks_auto',
      description: 'The impact slice is not demonstrably bounded.',
      evidence_refs: [staticFallbackRef]
    });
  }
  if (codeProfile.calls.some(({ dynamic }) => dynamic)) {
    blockers.push({
      kind: 'unresolved_effect',
      severity: 'blocks_dispatch',
      description: 'A dynamic invocation can hide calls or effects outside the static slice.',
      evidence_refs: codeProfile.evidence.filter(({ kind }) => kind === 'call').map(({ id }) => id)
    });
  } else if (codeProfile.coverage.unresolved_call_ids.length > 0) {
    blockers.push({
      kind: 'insufficient_coverage',
      severity: 'blocks_auto',
      description: 'One or more calls in the selected slice are unresolved.',
      evidence_refs: codeProfile.evidence.filter(({ kind }) => kind === 'call').map(({ id }) => id)
    });
  }
  if (taskProfile.acceptance.some(({ executable }) => !executable)) {
    blockers.push({
      kind: 'unexecutable_acceptance',
      severity: 'blocks_auto',
      description: 'At least one acceptance criterion cannot be executed automatically.',
      evidence_refs: [`task:${taskProfile.id}`]
    });
  }
  for (const ambiguity of semanticAssessment.ambiguities.filter(({ material }) => material)) {
    blockers.push({
      kind: 'missing_context',
      severity: 'blocks_dispatch',
      description: ambiguity.description,
      evidence_refs: [semanticAssessment.claims[0]?.id ?? `task:${taskProfile.id}`]
    });
  }
  for (const context of semanticAssessment.required_context.filter(({ required }) => required)) {
    blockers.push({
      kind: 'missing_context',
      severity: 'blocks_dispatch',
      description: `${context.reference}: ${context.reason}`,
      evidence_refs: [semanticAssessment.claims[0]?.id ?? `task:${taskProfile.id}`]
    });
  }

  for (const claim of semanticAssessment.claims) {
    if (claim.evidence_ref === null || !knownInputEvidence.has(claim.evidence_ref)) {
      blockers.push({
        kind: 'unsupported_claim',
        severity: 'blocks_auto',
        description: `Claim ${claim.id} has no valid input evidence reference.`,
        evidence_refs: [claim.id]
      });
    }
    if (claim.static_check !== null) {
      const actual = evaluateStaticCheck(claim.static_check, codeProfile);
      if (actual !== claim.static_check.expected) {
        const staticEvidenceRef = claim.evidence_ref && staticEvidenceIds.has(claim.evidence_ref)
          ? claim.evidence_ref
          : staticFallbackRef;
        disagreements.push({
          claim_id: claim.id,
          static_evidence_ref: staticEvidenceRef,
          material: true,
          description: `Static check ${claim.static_check.kind} for ${claim.static_check.subject} evaluated to ${actual}.`
        });
        blockers.push({
          kind: 'disagreement',
          severity: 'blocks_dispatch',
          description: `Claim ${claim.id} conflicts with the static slice.`,
          evidence_refs: [claim.id, staticEvidenceRef]
        });
      }
    }
  }

  const controlTotal = codeProfile.symbols.reduce(
    (total, symbol) => total + symbol.control_flow.branch_count + symbol.control_flow.loop_count,
    0
  );
  const intrinsicLevel = codeProfile.files.some(({ parsed }) => !parsed)
    ? 'unknown'
    : categoryLevel(controlTotal, 4, 10);
  const intrinsicRef = policyEvidence(
    'intrinsic_complexity',
    `Control-flow branch and loop total ${controlTotal} maps to ${intrinsicLevel}.`,
    codeProfile.evidence.filter(({ kind }) => kind === 'symbol').map(({ id }) => id)
  );

  const semanticSignals = semanticAssessment.semantic_risks.length +
    Number(semanticAssessment.required_capabilities.includes('deep_reasoning')) +
    Number(semanticAssessment.required_capabilities.includes('migration_design'));
  const semanticLevel = categoryLevel(semanticSignals, 1, 3);
  const semanticRef = policyEvidence(
    'semantic_difficulty',
    `${semanticSignals} explicit semantic risk or deep-design signals map to ${semanticLevel}.`,
    semanticAssessment.claims.map(({ id }) => id)
  );

  const dependencyCount = codeProfile.dependencies.length;
  const couplingSignals = dependencyCount + codeProfile.coverage.unresolved_call_ids.length * 2;
  const couplingLevel = categoryLevel(couplingSignals, 3, 8);
  const couplingRef = policyEvidence(
    'coupling',
    `${dependencyCount} dependencies and ${codeProfile.coverage.unresolved_call_ids.length} unresolved calls map to ${couplingLevel}.`
  );

  const selectedIds = new Set(codeProfile.symbols.map(({ id }) => id));
  const directDependents = new Set(
    codeProfile.calls
      .filter(({ resolved_symbol_id, caller_symbol_id }) => (
        resolved_symbol_id && selectedIds.has(resolved_symbol_id) && selectedIds.has(caller_symbol_id)
      ))
      .map(({ caller_symbol_id }) => caller_symbol_id)
  ).size;
  const transitiveDependents = ['callers', 'architecture'].includes(taskProfile.change_surface)
    ? Math.max(0, codeProfile.symbols.length - impactSlice.target_symbol_ids.length)
    : directDependents;
  const blastLevel = categoryLevel(transitiveDependents + codeProfile.files.length - 1, 3, 10);
  const blastRef = policyEvidence(
    'blast_radius',
    `${transitiveDependents} dependents across ${codeProfile.files.length} files map to ${blastLevel}.`
  );

  const acceptanceCommands = taskProfile.acceptance
    .filter(({ executable }) => executable)
    .map(({ command_or_assertion }) => command_or_assertion);
  const discoveredCommands = codeProfile.tests.flatMap(({ commands }) => commands);
  const commands = [...new Set([...acceptanceCommands, ...discoveredCommands])].sort();
  const testabilityLevel = commands.length > 0 && taskProfile.acceptance.every(({ executable }) => executable)
    ? 'good'
    : commands.length > 0 ? 'partial' : 'poor';
  const testabilityRef = policyEvidence(
    'testability',
    `${commands.length} executable validation commands map to ${testabilityLevel}.`
  );

  const reversibilityLevel = taskProfile.change_surface === 'body'
    ? 'high'
    : ['signature', 'callers'].includes(taskProfile.change_surface) ? 'moderate' : 'low';
  const reversibilityRef = policyEvidence(
    'reversibility',
    `Change surface ${taskProfile.change_surface} maps to ${reversibilityLevel}.`,
    [`task:${taskProfile.id}`]
  );

  const requiredCapabilities = new Set(['code_editing', 'tool_use', 'php_semantics']);
  for (const capability of semanticAssessment.required_capabilities) {
    requiredCapabilities.add(capability);
  }
  if (codeProfile.dependencies.some(({ kind }) => kind === 'framework')) {
    requiredCapabilities.add('framework_semantics');
  }
  if (taskProfile.operation === 'migrate' || ['data_contract', 'architecture'].includes(taskProfile.change_surface)) {
    requiredCapabilities.add('migration_design');
  }
  if (taskProfile.change_surface === 'architecture') {
    requiredCapabilities.add('deep_reasoning');
  }
  if (taskProfile.acceptance.some(({ kind }) => kind === 'test')) {
    requiredCapabilities.add('test_generation');
  }

  const contextTokens = codeProfile.symbols.reduce(
    (total, symbol) => total + (symbol.location.end_line - symbol.location.start_line + 1) * 20,
    0
  );
  const contextRef = policyEvidence(
    'context_estimate',
    `Estimated ${contextTokens} tokens from selected source spans at 20 tokens per line.`
  );
  const parsedFileRatio = ratio(codeProfile.coverage.files_parsed, codeProfile.coverage.files_total);
  const resolvedCallRatio = ratio(codeProfile.coverage.calls_resolved, codeProfile.coverage.calls_total);

  const requirements = [
    ...taskProfile.constraints.map((constraint, index) => ({
      id: deterministicId('requirement', taskProfile.id, 'constraint', index),
      source: 'task',
      description: `${constraint.kind} ${constraint.subject}: ${JSON.stringify(constraint.expected)}`,
      evidence_refs: [`task:${taskProfile.id}`]
    })),
    ...taskProfile.acceptance.map((acceptance, index) => ({
      id: deterministicId('requirement', taskProfile.id, 'acceptance', index),
      source: 'task',
      description: `${acceptance.kind}: ${acceptance.command_or_assertion}`,
      evidence_refs: [`task:${taskProfile.id}`]
    })),
    ...semanticAssessment.claims
      .filter(({ kind }) => ['requirement', 'invariant'].includes(kind))
      .map((claim) => ({
        id: deterministicId('requirement', taskProfile.id, claim.id),
        source: 'semantic',
        description: claim.statement,
        evidence_refs: [claim.id]
      }))
  ];

  evidence.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema_version: '1.0.0',
    match_id: deterministicId('match', taskProfile.id, codeProfile.profile_id, semanticAssessment.assessment_id),
    task_id: taskProfile.id,
    operation: taskProfile.operation,
    change_surface: taskProfile.change_surface,
    code_profile_id: codeProfile.profile_id,
    semantic_assessment_id: semanticAssessment.assessment_id,
    affected_symbols: codeProfile.symbols.map(({ id }) => id).sort(),
    affected_files: codeProfile.files.map(({ path }) => path).sort(),
    context_estimate: {
      file_count: codeProfile.files.length,
      symbol_count: codeProfile.symbols.length,
      estimated_tokens: contextTokens,
      bounded: impactSlice.bounded
    },
    intrinsic_complexity: { level: intrinsicLevel, evidence_refs: [intrinsicRef] },
    semantic_difficulty: { level: semanticLevel, evidence_refs: [semanticRef] },
    coupling: { level: couplingLevel, evidence_refs: [couplingRef] },
    effect_kinds: [...new Set(codeProfile.effects.map(({ kind }) => kind))].sort(),
    blast_radius: {
      level: blastLevel,
      direct_dependents: directDependents,
      transitive_dependents: impactSlice.bounded ? transitiveDependents : null,
      evidence_refs: [blastRef]
    },
    testability: { level: testabilityLevel, commands, evidence_refs: [testabilityRef] },
    reversibility: { level: reversibilityLevel, evidence_refs: [reversibilityRef] },
    unresolved_calls: codeProfile.calls.filter(({ resolved }) => !resolved).map(({ id }) => id).sort(),
    analysis_coverage: { parsed_file_ratio: parsedFileRatio, resolved_call_ratio: resolvedCallRatio, bounded: impactSlice.bounded },
    semantic_confidence: semanticAssessment.confidence,
    requirements,
    required_capabilities: [...requiredCapabilities].sort().map((capability) => ({
      capability,
      provenance: {
        source: 'matcher',
        confidence: 1,
        evidence_refs: [semanticRef, contextRef]
      }
    })),
    blockers,
    disagreements,
    evidence
  };
}