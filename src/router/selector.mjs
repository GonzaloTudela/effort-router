import { deterministicId, stableStringify } from '../analyzer/stable.mjs';

const EFFORT_RANK = new Map([
  [null, 0],
  ['low', 1],
  ['medium', 2],
  ['high', 3],
  ['xhigh', 4],
  ['max', 5]
]);

function contextBucket(tokens) {
  if (tokens === null) {
    return 'unknown';
  }
  if (tokens <= 50000) {
    return 'small';
  }
  if (tokens <= 180000) {
    return 'medium';
  }
  if (tokens <= 900000) {
    return 'large';
  }
  return 'very_large';
}

export function calibrationFeatureKey(matchProfile) {
  return stableStringify({
    operation: matchProfile.operation,
    change_surface: matchProfile.change_surface,
    intrinsic_complexity: matchProfile.intrinsic_complexity.level,
    semantic_difficulty: matchProfile.semantic_difficulty.level,
    coupling: matchProfile.coupling.level,
    blast_radius: matchProfile.blast_radius.level,
    testability: matchProfile.testability.level,
    effect_kinds: [...matchProfile.effect_kinds].sort(),
    required_capabilities: matchProfile.required_capabilities.map(({ capability }) => capability).sort(),
    context_bucket: contextBucket(matchProfile.context_estimate.estimated_tokens)
  });
}

export function wilsonLowerBound(successes, attempts, z = 1.96) {
  if (attempts === 0) {
    return null;
  }
  const proportion = successes / attempts;
  const zSquared = z * z;
  const denominator = 1 + zSquared / attempts;
  const center = proportion + zSquared / (2 * attempts);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * attempts)) / attempts);
  return Math.max(0, (center - margin) / denominator);
}

function candidateKey(model, effort) {
  return `${model}\u0000${effort ?? '<none>'}`;
}

function calibrationFor(history, model, effort, featureKey, z, historyCompatible) {
  const records = historyCompatible ? history.records.filter((record) => (
    record.model === model &&
    record.effort === effort &&
    record.feature_key === featureKey
  )) : [];
  const attempts = records.reduce((total, record) => total + record.attempts, 0);
  const successes = records.reduce((total, record) => total + record.successes, 0);
  return {
    attempts,
    successes,
    lower_bound: wilsonLowerBound(successes, attempts, z),
    latency_ms: records.length === 0
      ? null
      : Math.max(...records.map(({ median_latency_ms }) => median_latency_ms ?? 0)),
    cost_units: records.length === 0
      ? null
      : Math.max(...records.map(({ median_cost_units }) => median_cost_units ?? 0))
  };
}

function expandCandidates(matchProfile, catalog, policy, approvedModels) {
  const requiredCapabilities = new Set(matchProfile.required_capabilities.map(({ capability }) => capability));
  requiredCapabilities.delete('human_approval');
  const estimatedTokens = matchProfile.context_estimate.estimated_tokens;
  const candidates = [];
  const rejected = [];

  for (const model of catalog.models) {
    const reasons = [];
    if (!model.enabled) {
      reasons.push('model_disabled');
    }
    const missingCapabilities = [...requiredCapabilities].filter((capability) => !model.capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      reasons.push(`missing_capabilities:${missingCapabilities.join(',')}`);
    }
    if (estimatedTokens === null || estimatedTokens > model.context_window * policy.context_safety_ratio) {
      reasons.push('insufficient_context_window');
    }
    if (model.approval_required && !approvedModels.has(model.id)) {
      reasons.push('approval_required');
    }
    for (const effort of model.supported_efforts) {
      if (reasons.length > 0) {
        rejected.push({ model: model.id, effort, reasons: [...reasons] });
        continue;
      }
      const effortRank = EFFORT_RANK.get(effort) ?? 9;
      candidates.push({
        model: model.id,
        effort,
        context_window: model.context_window,
        capability_rank: model.capability_rank,
        cost_rank: model.cost_rank * 10 + effortRank,
        latency_rank: model.latency_rank * 10 + effortRank
      });
    }
  }
  return { candidates, rejected };
}

function guardEvidence(matchProfile, blockerKinds = []) {
  const blockerRefs = matchProfile.blockers
    .filter(({ kind }) => blockerKinds.includes(kind))
    .flatMap(({ evidence_refs }) => evidence_refs);
  return [...new Set(blockerRefs.length > 0 ? blockerRefs : [matchProfile.evidence[0]?.id ?? `match:${matchProfile.match_id}`])];
}

function determineBlockedAction(matchProfile, mode, policy, guardResults) {
  const blockerKinds = new Set(matchProfile.blockers.map(({ kind }) => kind));
  if (blockerKinds.has('contract_incomplete')) {
    return 'request_task_contract';
  }
  if (blockerKinds.has('disagreement') || blockerKinds.has('parse_failure') || blockerKinds.has('unresolved_effect')) {
    return 'human_review';
  }
  if (matchProfile.required_capabilities.some(({ capability }) => capability === 'human_approval')) {
    return 'human_review';
  }
  const confidenceMinimum = mode === 'auto'
    ? policy.confidence.auto_minimum
    : policy.confidence.confirm_minimum;
  if (matchProfile.semantic_confidence.overall < confidenceMinimum || blockerKinds.has('unsupported_claim')) {
    return 'escalate_critic';
  }
  const callCoverageMinimum = mode === 'auto'
    ? policy.coverage.auto_resolved_call_ratio
    : policy.coverage.confirm_resolved_call_ratio;
  if (
    blockerKinds.has('missing_context') ||
    blockerKinds.has('unbounded_slice') ||
    !matchProfile.analysis_coverage.bounded ||
    matchProfile.analysis_coverage.parsed_file_ratio < policy.coverage.parsed_file_ratio ||
    matchProfile.analysis_coverage.resolved_call_ratio < callCoverageMinimum
  ) {
    return 'request_context';
  }
  if (mode === 'auto' && blockerKinds.has('unexecutable_acceptance')) {
    return 'human_review';
  }
  if (guardResults.some(({ outcome }) => outcome === 'block_dispatch')) {
    return 'human_review';
  }
  return null;
}

function evaluateGuards(matchProfile, mode, policy) {
  const confidenceMinimum = mode === 'auto'
    ? policy.confidence.auto_minimum
    : policy.confidence.confirm_minimum;
  const callCoverageMinimum = mode === 'auto'
    ? policy.coverage.auto_resolved_call_ratio
    : policy.coverage.confirm_resolved_call_ratio;
  const hasDispatchBlocker = matchProfile.blockers.some(({ severity }) => severity === 'blocks_dispatch');
  const hasAutoBlocker = matchProfile.blockers.some(({ severity }) => severity === 'blocks_auto');
  const defaultRefs = guardEvidence(matchProfile);
  return [
    {
      guard: 'reconciled-blockers',
      outcome: hasDispatchBlocker ? 'block_dispatch' : mode === 'auto' && hasAutoBlocker ? 'block_auto' : 'pass',
      reason: `${matchProfile.blockers.length} explicit blockers are present.`,
      evidence_refs: defaultRefs
    },
    {
      guard: 'semantic-confidence',
      outcome: matchProfile.semantic_confidence.overall >= confidenceMinimum ? 'pass' : mode === 'auto' ? 'block_auto' : 'block_dispatch',
      reason: `Confidence ${matchProfile.semantic_confidence.overall} requires at least ${confidenceMinimum}.`,
      evidence_refs: defaultRefs
    },
    {
      guard: 'analysis-coverage',
      outcome: (
        matchProfile.analysis_coverage.bounded &&
        matchProfile.analysis_coverage.parsed_file_ratio >= policy.coverage.parsed_file_ratio &&
        matchProfile.analysis_coverage.resolved_call_ratio >= callCoverageMinimum
      ) ? 'pass' : mode === 'auto' ? 'block_auto' : 'block_dispatch',
      reason: `Parsed ratio ${matchProfile.analysis_coverage.parsed_file_ratio}; resolved-call ratio ${matchProfile.analysis_coverage.resolved_call_ratio}.`,
      evidence_refs: defaultRefs
    },
    {
      guard: 'executable-acceptance',
      outcome: mode === 'auto' && matchProfile.blockers.some(({ kind }) => kind === 'unexecutable_acceptance') ? 'block_auto' : 'pass',
      reason: `${matchProfile.testability.commands.length} executable validation commands are available.`,
      evidence_refs: defaultRefs
    }
  ];
}

function decisionVersions(matchProfile, catalog, policy, history, overrides) {
  return {
    prompt: overrides.prompt ?? '1.0.0',
    task_schema: '1.0.0',
    code_schema: '1.0.0',
    semantic_schema: '1.0.0',
    match_schema: matchProfile.schema_version,
    route_schema: '1.0.0',
    policy: policy.policy_version,
    model_catalog: catalog.catalog_version,
    analyzer: overrides.analyzer ?? '1.0.0'
  };
}

function candidateRejections(evaluated, selected, taskProfile, policy) {
  return evaluated
    .filter((candidate) => !selected || candidate.model !== selected.model || candidate.effort !== selected.effort)
    .map((candidate) => {
      const reasons = [];
      if (candidate.calibration.attempts < policy.calibration.minimum_comparable_samples) {
        reasons.push(`insufficient_samples:${candidate.calibration.attempts}`);
      } else if (candidate.calibration.lower_bound < taskProfile.quality_target) {
        reasons.push(`quality_lower_bound:${candidate.calibration.lower_bound}`);
      } else {
        reasons.push('higher_latency_or_cost');
      }
      return { model: candidate.model, effort: candidate.effort, reasons };
    });
}

export function selectRoute({
  taskProfile,
  matchProfile,
  catalog,
  policy,
  history,
  mode = 'confirm',
  approvedModels = [],
  versions = {}
}) {
  for (const record of history.records) {
    if (record.successes > record.attempts) {
      throw new RangeError(`Calibration successes exceed attempts for ${record.case_id}.`);
    }
  }
  const guardResults = evaluateGuards(matchProfile, mode, policy);
  const blockedAction = determineBlockedAction(matchProfile, mode, policy, guardResults);
  const requiredContext = matchProfile.blockers
    .filter(({ kind }) => ['missing_context', 'unbounded_slice', 'insufficient_coverage'].includes(kind))
    .map(({ description }) => description);
  const currentVersions = decisionVersions(matchProfile, catalog, policy, history, versions);
  const common = {
    schema_version: '1.0.0',
    decision_id: deterministicId('decision', taskProfile.id, matchProfile.match_id, mode, policy.policy_version),
    task_id: taskProfile.id,
    match_id: matchProfile.match_id,
    mode,
    required_context: [...new Set(requiredContext)],
    guard_results: guardResults,
    versions: currentVersions
  };

  if (blockedAction) {
    return {
      ...common,
      action: blockedAction,
      selected_candidate: null,
      rejected_candidates: [],
      calibration: {
        dataset_version: history.dataset_version,
        comparable_sample_size: 0,
        success_lower_bound: null,
        quality_target: taskProfile.quality_target
      },
      trigger_evidence_refs: guardEvidence(matchProfile)
    };
  }

  const { candidates, rejected } = expandCandidates(
    matchProfile,
    catalog,
    policy,
    new Set(approvedModels)
  );
  if (candidates.length === 0) {
    return {
      ...common,
      action: 'human_review',
      selected_candidate: null,
      rejected_candidates: rejected,
      calibration: {
        dataset_version: history.dataset_version,
        comparable_sample_size: 0,
        success_lower_bound: null,
        quality_target: taskProfile.quality_target
      },
      trigger_evidence_refs: [`policy:model-catalog:${catalog.catalog_version}`]
    };
  }

  const featureKey = calibrationFeatureKey(matchProfile);
  const historyCompatible = (
    history.versions.prompt === currentVersions.prompt &&
    history.versions.policy === currentVersions.policy &&
    history.versions.model_catalog === currentVersions.model_catalog &&
    history.versions.analyzer === currentVersions.analyzer
  );
  const evaluated = candidates.map((candidate) => ({
    ...candidate,
    calibration: calibrationFor(
      history,
      candidate.model,
      candidate.effort,
      featureKey,
      policy.calibration.wilson_z,
      historyCompatible
    )
  }));
  const calibrated = evaluated
    .filter(({ calibration }) => (
      calibration.attempts >= policy.calibration.minimum_comparable_samples &&
      calibration.lower_bound >= taskProfile.quality_target
    ))
    .sort((left, right) => (
      (left.calibration.latency_ms ?? left.latency_rank) - (right.calibration.latency_ms ?? right.latency_rank) ||
      (left.calibration.cost_units ?? left.cost_rank) - (right.calibration.cost_units ?? right.cost_rank) ||
      left.model.localeCompare(right.model) ||
      String(left.effort).localeCompare(String(right.effort))
    ));

  let selected = calibrated[0] ?? null;
  let selectionEvidence;
  if (selected) {
    selectionEvidence = `history:${history.dataset_version}:${candidateKey(selected.model, selected.effort)}`;
  } else if (mode === 'confirm') {
    selected = evaluated.sort((left, right) => (
      right.capability_rank - left.capability_rank ||
      (EFFORT_RANK.get(right.effort) ?? 0) - (EFFORT_RANK.get(left.effort) ?? 0) ||
      left.latency_rank - right.latency_rank ||
      left.cost_rank - right.cost_rank
    ))[0];
    selectionEvidence = `policy:bootstrap-conservative:${policy.policy_version}`;
  } else {
    return {
      ...common,
      action: 'human_review',
      selected_candidate: null,
      rejected_candidates: [...rejected, ...candidateRejections(evaluated, null, taskProfile, policy)],
      calibration: {
        dataset_version: history.dataset_version,
        comparable_sample_size: Math.max(...evaluated.map(({ calibration }) => calibration.attempts)),
        success_lower_bound: null,
        quality_target: taskProfile.quality_target
      },
      trigger_evidence_refs: [`policy:insufficient-calibration:${policy.policy_version}`]
    };
  }

  const selectedCalibration = selected.calibration;
  return {
    ...common,
    action: 'dispatch',
    selected_candidate: {
      model: selected.model,
      effort: selected.effort,
      context_window: selected.context_window,
      cost_rank: selected.cost_rank,
      latency_rank: selected.latency_rank,
      evidence_refs: [selectionEvidence]
    },
    rejected_candidates: [...rejected, ...candidateRejections(evaluated, selected, taskProfile, policy)],
    calibration: {
      dataset_version: history.dataset_version,
      comparable_sample_size: selectedCalibration.attempts,
      success_lower_bound: selectedCalibration.lower_bound,
      quality_target: taskProfile.quality_target
    },
    trigger_evidence_refs: [...new Set([selectionEvidence, ...guardEvidence(matchProfile)])]
  };
}