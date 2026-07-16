export function evaluatePromotion(observations, gates) {
  const safetyReasons = [];
  if (observations.safety.unsafe_auto_routes > gates.safety.maximum_unsafe_auto_routes) {
    safetyReasons.push('unsafe_auto_routes');
  }
  if (observations.safety.determinism_rate < gates.safety.minimum_determinism_rate) {
    safetyReasons.push('determinism_below_gate');
  }
  if (observations.safety.schema_compliance < gates.safety.minimum_schema_compliance) {
    safetyReasons.push('schema_compliance_below_gate');
  }

  const promotionReasons = [...safetyReasons];
  if (observations.retained.sample_size < gates.promotion.minimum_retained_samples) {
    promotionReasons.push('insufficient_retained_samples');
  }
  if (
    observations.retained.current_success_rate <
    observations.retained.baseline_success_rate - gates.promotion.maximum_success_regression
  ) {
    promotionReasons.push('retained_success_regression');
  }
  if (
    observations.retained.current_correction_rate >
    observations.retained.baseline_correction_rate + gates.promotion.maximum_correction_regression
  ) {
    promotionReasons.push('retained_correction_regression');
  }

  const rustReasons = [...safetyReasons];
  if (observations.profiling.repositories < gates.rust.minimum_repositories) {
    rustReasons.push('insufficient_profiled_repositories');
  }
  if (observations.profiling.php_files < gates.rust.minimum_php_files) {
    rustReasons.push('insufficient_profiled_php_files');
  }
  if (
    observations.profiling.analyzer_latency_share === null ||
    observations.profiling.analyzer_latency_share < gates.rust.minimum_analyzer_latency_share
  ) {
    rustReasons.push('analyzer_not_proven_bottleneck');
  }
  if (
    observations.profiling.measured_speedup === null ||
    observations.profiling.measured_speedup < gates.rust.minimum_speedup
  ) {
    rustReasons.push('required_speedup_not_measured');
  }
  if (gates.rust.require_byte_compatible_json && !observations.profiling.byte_compatible_json) {
    rustReasons.push('byte_compatibility_not_proven');
  }
  return {
    schema_version: '1.0.0',
    gates_version: gates.gates_version,
    prompt_policy_promotion: {
      approved: promotionReasons.length === 0,
      reasons: promotionReasons
    },
    rust: {
      approved: rustReasons.length === 0,
      reasons: rustReasons
    }
  };
}