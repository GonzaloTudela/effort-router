import { wilsonLowerBound } from '../router/selector.mjs';

function median(values) {
  const known = values.filter((value) => value !== null).sort((left, right) => left - right);
  if (known.length === 0) {
    return null;
  }
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 0 ? (known[middle - 1] + known[middle]) / 2 : known[middle];
}

export function summarizeExecutionRecords(records, {
  datasetVersion,
  split,
  generatedAt = new Date().toISOString(),
  wilsonZ = 1.96
}) {
  const groups = new Map();
  for (const record of records.filter(({ route }) => route.action === 'dispatch' && route.model !== null)) {
    const key = `${record.route.model}\u0000${record.route.effort ?? '<none>'}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(record);
  }
  const routes = [...groups.values()].map((routeRecords) => {
    const sampleSize = routeRecords.length;
    const successes = routeRecords.filter(({ outcome }) => outcome.success).length;
    return {
      model: routeRecords[0].route.model,
      effort: routeRecords[0].route.effort,
      sample_size: sampleSize,
      successes,
      success_rate: successes / sampleSize,
      success_lower_bound: wilsonLowerBound(successes, sampleSize, wilsonZ),
      correction_rate: routeRecords.filter(({ outcome }) => outcome.human_corrections > 0).length / sampleSize,
      scope_violation_rate: routeRecords.filter(({ outcome }) => outcome.scope_violations > 0).length / sampleSize,
      median_latency_ms: median(routeRecords.map(({ latency_ms }) => latency_ms.total))
    };
  }).sort((left, right) => (
    left.model.localeCompare(right.model) || String(left.effort).localeCompare(String(right.effort))
  ));
  return {
    schema_version: '1.0.0',
    dataset_version: datasetVersion,
    split,
    generated_at: generatedAt,
    total_records: records.length,
    routes
  };
}