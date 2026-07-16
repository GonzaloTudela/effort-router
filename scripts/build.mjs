import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'dist', 'analyzer.mjs');
const check = process.argv.includes('--check');
const result = await build({
  entryPoints: [path.join(root, 'src', 'cli', 'analyzer.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  write: false
});
const output = result.outputFiles[0].contents;

if (check) {
  let existing;
  try {
    existing = await readFile(outputPath);
  } catch {
    throw new Error('dist/analyzer.mjs is missing; run npm run build.');
  }
  if (!existing.equals(output)) {
    throw new Error('dist/analyzer.mjs is stale; run npm run build.');
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}