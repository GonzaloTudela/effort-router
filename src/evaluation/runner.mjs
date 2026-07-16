export async function runEvaluationCase(evaluationCase, adapters) {
  const taskProfile = await adapters.loadTaskProfile(
    evaluationCase.task_profile_path,
    evaluationCase.task_profile_pointer
  );
  const criticRuns = [];
  const actorRuns = [];

  for (let repetition = 0; repetition < evaluationCase.repetitions; repetition += 1) {
    const criticResult = await adapters.runCritic({ evaluationCase, taskProfile, repetition });
    criticRuns.push({
      repetition,
      schema_valid: criticResult.schema_valid,
      reference_fields_matched: criticResult.reference_fields_matched,
      claim_references_valid: criticResult.claim_references_valid,
      latency_ms: criticResult.latency_ms ?? null,
      usage: criticResult.usage ?? null,
      version: criticResult.version
    });

    for (const candidate of evaluationCase.candidate_routes) {
      const actorResult = await adapters.runActor({
        evaluationCase,
        taskProfile,
        candidate,
        repetition
      });
      actorRuns.push({
        repetition,
        model: candidate.model,
        effort: candidate.effort,
        acceptance_passed: actorResult.acceptance_passed,
        tests_passed: actorResult.tests_passed,
        scope_violations: actorResult.scope_violations,
        human_corrections: actorResult.human_corrections,
        latency_ms: actorResult.latency_ms ?? null,
        cost_units: actorResult.cost_units ?? null,
        usage: actorResult.usage ?? null,
        version: actorResult.version
      });
    }
  }
  return {
    schema_version: '1.0.0',
    case_id: evaluationCase.id,
    split: evaluationCase.split,
    critic_runs: criticRuns,
    actor_runs: actorRuns
  };
}

function median(values) {
  const known = values.filter((value) => value !== null).sort((left, right) => left - right);
  if (known.length === 0) {
    return null;
  }
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 0 ? (known[middle - 1] + known[middle]) / 2 : known[middle];
}

export function aggregateActorRuns(evaluationResult, featureKey) {
  const groups = new Map();
  for (const run of evaluationResult.actor_runs) {
    const key = `${run.model}\u0000${run.effort ?? '<none>'}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(run);
  }
  return [...groups.values()].map((runs) => ({
    case_id: evaluationResult.case_id,
    feature_key: featureKey,
    model: runs[0].model,
    effort: runs[0].effort,
    attempts: runs.length,
    successes: runs.filter((run) => (
      run.acceptance_passed &&
      run.tests_passed &&
      run.scope_violations === 0 &&
      run.human_corrections === 0
    )).length,
    median_latency_ms: median(runs.map(({ latency_ms }) => latency_ms)),
    median_cost_units: median(runs.map(({ cost_units }) => cost_units))
  })).sort((left, right) => (
    left.model.localeCompare(right.model) || String(left.effort).localeCompare(String(right.effort))
  ));
}