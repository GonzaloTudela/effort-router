import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function loadRoutingAssets(paths = {}) {
  const [catalog, policy, history] = await Promise.all([
    readJson(paths.catalog ?? path.join(root, 'policy', 'model-catalog.json')),
    readJson(paths.policy ?? path.join(root, 'policy', 'router-policy.json')),
    readJson(paths.history ?? path.join(root, 'evaluation', 'results', 'bootstrap-calibration.json'))
  ]);
  return { catalog, policy, history };
}