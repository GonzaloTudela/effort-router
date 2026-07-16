import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { analyzePhpFiles } from '../src/analyzer/index.mjs';
import { sha256, stableStringify } from '../src/analyzer/stable.mjs';

const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf('--output');
const outputPath = outputIndex >= 0 ? argumentsList[outputIndex + 1] : null;
if (outputIndex >= 0) {
  argumentsList.splice(outputIndex, 2);
}
const roots = argumentsList.length > 0 ? argumentsList.map((value) => path.resolve(value)) : [process.cwd()];

async function discover(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || ['.git', '.junie', 'node_modules', 'vendor'].includes(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.php')) {
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return files;
}

const repositories = [];
for (const root of roots) {
  const discovered = await discover(root);
  const files = await Promise.all(discovered.map(async (absolutePath) => ({
    path: path.relative(root, absolutePath).replaceAll('\\', '/'),
    source: await readFile(absolutePath, 'utf8')
  })));
  const started = performance.now();
  const profile = await analyzePhpFiles(files);
  const elapsed = performance.now() - started;
  repositories.push({
    repository_id: sha256(root).slice(0, 16),
    php_files: files.length,
    source_bytes: files.reduce((total, file) => total + Buffer.byteLength(file.source), 0),
    symbols: profile.symbols.length,
    calls: profile.calls.length,
    unresolved_calls: profile.coverage.unresolved_call_ids.length,
    analysis_ms: Math.round(elapsed * 1000) / 1000,
    profile_hash: sha256(stableStringify(profile))
  });
}
const report = {
  schema_version: '1.0.0',
  analyzer_version: '1.0.0',
  generated_at: new Date().toISOString(),
  repositories,
  totals: {
    repositories: repositories.length,
    php_files: repositories.reduce((total, item) => total + item.php_files, 0),
    source_bytes: repositories.reduce((total, item) => total + item.source_bytes, 0),
    analysis_ms: Math.round(repositories.reduce((total, item) => total + item.analysis_ms, 0) * 1000) / 1000
  },
  analyzer_latency_share: null,
  measured_rust_speedup: null,
  byte_compatible_json: false,
  privacy: { source_stored: false, repository_paths_stored: false }
};
const serialized = stableStringify(report);
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized);
} else {
  process.stdout.write(serialized);
}