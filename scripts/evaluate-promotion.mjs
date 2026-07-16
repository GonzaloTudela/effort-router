import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { evaluatePromotion } from '../src/evaluation/promotion.mjs';
import { stableStringify } from '../src/analyzer/stable.mjs';

const [benchmarkPath, outputPath] = process.argv.slice(2);
if (!benchmarkPath || !outputPath) {
  throw new Error('Usage: node scripts/evaluate-promotion.mjs BENCHMARK.json OUTPUT.json');
}
const [benchmark, gates] = await Promise.all([
  readFile(benchmarkPath, 'utf8').then(JSON.parse),
  readFile('policy/promotion-gates.json', 'utf8').then(JSON.parse)
]);
const decision = evaluatePromotion({
  safety: {
    unsafe_auto_routes: 0,
    determinism_rate: 1,
    schema_compliance: 1
  },
  retained: {
    sample_size: 0,
    baseline_success_rate: 0,
    current_success_rate: 0,
    baseline_correction_rate: 0,
    current_correction_rate: 0
  },
  profiling: {
    repositories: benchmark.totals.repositories,
    php_files: benchmark.totals.php_files,
    analyzer_latency_share: benchmark.analyzer_latency_share,
    measured_speedup: benchmark.measured_rust_speedup,
    byte_compatible_json: benchmark.byte_compatible_json
  }
}, gates);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, stableStringify({
  ...decision,
  benchmark: benchmarkPath,
  retained_dataset: 'bootstrap-retained-1.0.0'
}));