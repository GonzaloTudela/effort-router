#!/usr/bin/env node

import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzePhpFiles,
  buildImpactSlice,
  PHP_ANALYZER_VERSION,
  stableStringify
} from '../analyzer/index.mjs';
import { createContractValidator } from '../contracts/validator.mjs';
import { summarizeExecutionRecords } from '../evaluation/metrics.mjs';
import { appendExecutionRecord, createExecutionRecord } from '../evaluation/records.mjs';
import { reconcileProfiles } from '../matcher/reconcile.mjs';
import { buildActorPayload } from '../plugin/actor-payload.mjs';
import { buildTaskDag } from '../plans/dag.mjs';
import { loadRoutingAssets } from '../router/assets.mjs';
import { selectRoute } from '../router/selector.mjs';

function parseArguments(argv) {
  const result = { command: argv[0] ?? 'help', values: {} };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result.values[name] = true;
    } else {
      result.values[name] = next;
      index += 1;
    }
  }
  return result;
}

async function readStandardInput() {
  if (process.stdin.isTTY) {
    return null;
  }
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value.trim() ? JSON.parse(value) : null;
}

async function findPluginRoot() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..'),
    path.resolve(moduleDirectory, '..', '..'),
    process.cwd()
  ];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, 'schemas', 'task-profile.schema.json'));
      return candidate;
    } catch {
      // Continue to the next deterministic candidate.
    }
  }
  throw new Error('Cannot locate the effort-router plugin root and schemas.');
}

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes analysis root: ${relativePath}`);
  }
  return resolved;
}

async function collectPhpPaths(root, requestedPaths) {
  const found = new Set();
  async function visit(candidate) {
    const details = await stat(candidate);
    if (details.isDirectory()) {
      const entries = await readdir(candidate, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink() || ['.git', '.junie', 'node_modules', 'vendor'].includes(entry.name)) {
          continue;
        }
        await visit(path.join(candidate, entry.name));
      }
    } else if (details.isFile() && candidate.toLowerCase().endsWith('.php')) {
      found.add(candidate);
    }
  }
  for (const requestedPath of [...new Set(requestedPaths)].sort()) {
    try {
      await visit(safePath(root, requestedPath));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return [...found].sort();
}

async function sourceFilesForTask(root, taskProfile) {
  const requestedPaths = [
    ...taskProfile.targets.map(({ path: targetPath }) => targetPath),
    ...taskProfile.context_roots
  ];
  const filePaths = await collectPhpPaths(root, requestedPaths);
  return Promise.all(filePaths.map(async (filePath) => ({
    path: path.relative(root, filePath).replaceAll('\\', '/'),
    source: await readFile(filePath, 'utf8')
  })));
}

async function routingAssetPaths(pluginRoot) {
  return {
    catalog: path.join(pluginRoot, 'policy', 'model-catalog.json'),
    policy: path.join(pluginRoot, 'policy', 'router-policy.json'),
    history: path.join(pluginRoot, 'evaluation', 'results', 'bootstrap-calibration.json')
  };
}

function catalogPaths(pluginRoot) {
  return ['php-core.json', 'wordpress.json', 'laravel.json']
    .map((name) => path.join(pluginRoot, 'rules', name));
}

async function runAnalyze(request, values, pluginRoot, contracts) {
  const taskProfile = request?.task_profile ?? JSON.parse(await readFile(values.spec, 'utf8'));
  contracts.validate('task-profile', taskProfile);
  const analysisRoot = path.resolve(request?.root ?? values.root ?? process.cwd());
  const files = request?.files ?? await sourceFilesForTask(analysisRoot, taskProfile);
  const codeProfile = await analyzePhpFiles(files, { catalogPaths: catalogPaths(pluginRoot) });
  contracts.validate('code-profile', codeProfile);
  return {
    code_profile: codeProfile,
    impact_slice: buildImpactSlice(taskProfile, codeProfile)
  };
}

async function runRoute(request, pluginRoot, contracts) {
  contracts.validate('task-profile', request.task_profile);
  contracts.validate('semantic-assessment', request.semantic_assessment);
  contracts.validate('code-profile', request.impact_slice.code_profile);
  const matchProfile = reconcileProfiles(
    request.task_profile,
    request.semantic_assessment,
    request.impact_slice
  );
  contracts.validate('match-profile', matchProfile);
  const assets = await loadRoutingAssets(await routingAssetPaths(pluginRoot));
  contracts.validate('model-catalog', assets.catalog);
  contracts.validate('router-policy', assets.policy);
  contracts.validate('calibration-results', assets.history);
  const routeDecision = selectRoute({
    taskProfile: request.task_profile,
    matchProfile,
    catalog: assets.catalog,
    policy: assets.policy,
    history: assets.history,
    mode: request.mode ?? 'confirm',
    approvedModels: request.approved_models ?? []
  });
  contracts.validate('route-decision', routeDecision);
  return { match_profile: matchProfile, route_decision: routeDecision };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${PHP_ANALYZER_VERSION}\n`);
    return;
  }
  if (command === 'help') {
    process.stdout.write('Usage: analyzer.mjs <analyze|route|plan|actor-payload|record|metrics|version> [--root PATH] [--spec TASK.json]\n');
    return;
  }
  const pluginRoot = await findPluginRoot();
  const contracts = await createContractValidator(path.join(pluginRoot, 'schemas'));
  const request = await readStandardInput();
  let result;
  if (command === 'analyze') {
    if (!request && !values.spec) {
      throw new Error('analyze requires JSON on stdin or --spec TASK.json.');
    }
    result = await runAnalyze(request, values, pluginRoot, contracts);
  } else if (command === 'route') {
    if (!request) {
      throw new Error('route requires JSON on stdin.');
    }
    result = await runRoute(request, pluginRoot, contracts);
  } else if (command === 'plan') {
    if (!request) {
      throw new Error('plan requires JSON on stdin.');
    }
    for (const taskProfile of request.task_profiles) {
      contracts.validate('task-profile', taskProfile);
    }
    result = { dag: buildTaskDag(request.task_profiles, request.impact_slices ?? []) };
  } else if (command === 'actor-payload') {
    if (!request) {
      throw new Error('actor-payload requires JSON on stdin.');
    }
    result = buildActorPayload(request);
  } else if (command === 'record') {
    if (!request) {
      throw new Error('record requires JSON on stdin.');
    }
    result = createExecutionRecord({
      taskProfile: request.task_profile,
      codeProfile: request.code_profile,
      semanticAssessment: request.semantic_assessment,
      matchProfile: request.match_profile,
      routeDecision: request.route_decision,
      acceptance: request.outcome?.acceptance ?? [],
      testsPassed: request.outcome?.tests_passed ?? null,
      scopeViolations: request.outcome?.scope_violations ?? 0,
      humanCorrections: request.outcome?.human_corrections ?? 0,
      latencyMs: request.latency_ms ?? {},
      usage: request.usage ?? {},
      recordedAt: request.recorded_at
    });
    contracts.validate('execution-record', result);
    if (values.output) {
      await appendExecutionRecord(safePath(process.cwd(), values.output), result);
    }
  } else if (command === 'metrics') {
    if (!request) {
      throw new Error('metrics requires JSON on stdin.');
    }
    for (const record of request.records) {
      contracts.validate('execution-record', record);
    }
    result = summarizeExecutionRecords(request.records, {
      datasetVersion: request.dataset_version,
      split: request.split,
      generatedAt: request.generated_at,
      wilsonZ: request.wilson_z
    });
    contracts.validate('metrics-report', result);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(stableStringify(result));
}

main().catch((error) => {
  process.stderr.write(stableStringify({
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error'
  }));
  process.exitCode = 1;
});