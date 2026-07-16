import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

const [packageJson, policy, catalog, classifier] = await Promise.all([
  readJson('package.json'),
  readJson('policy/router-policy.json'),
  readJson('policy/model-catalog.json'),
  read('A-prompt/classifier.md')
]);
const promptMatch = classifier.match(/```text\r?\n([\s\S]*?)\r?\n```/);
if (!promptMatch) {
  throw new Error('Cannot extract CRITIC_SYSTEM_PROMPT from A-prompt/classifier.md.');
}
const values = {
  ANALYZER_VERSION: '1.0.0',
  CATALOG_VERSION: catalog.catalog_version,
  CRITIC_DEFAULT_MODEL: policy.critic.default_model,
  CRITIC_ESCALATION_MODEL: policy.critic.escalation_model,
  CRITIC_MAX_ATTEMPTS: String(policy.critic.max_attempts),
  CRITIC_PROMPT: promptMatch[1],
  NODE_REQUIREMENT: packageJson.engines.node,
  PACKAGE_VERSION: packageJson.version,
  POLICY_VERSION: policy.policy_version
};

function render(template) {
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${name}}}`, value);
  }
  const unresolved = output.match(/{{[A-Z0-9_]+}}/g);
  if (unresolved) {
    throw new Error(`Unresolved template values: ${unresolved.join(', ')}`);
  }
  return `${output.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

const outputs = new Map([
  ['templates/SKILL.md.tmpl', 'skills/effort-router/SKILL.md'],
  ['templates/README.md.tmpl', 'README.md'],
  ['templates/USAGE.md.tmpl', 'USAGE.md'],
  ['templates/PLAN.md.tmpl', 'PLAN.md']
]);
for (const [templatePath, outputPath] of outputs) {
  const generated = render(await read(templatePath));
  const absoluteOutput = path.join(root, outputPath);
  if (check) {
    let existing;
    try {
      existing = await readFile(absoluteOutput, 'utf8');
    } catch {
      throw new Error(`${outputPath} is missing; run npm run generate.`);
    }
    if (existing.replace(/\r\n/g, '\n') !== generated) {
      throw new Error(`${outputPath} is stale; run npm run generate.`);
    }
  } else {
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, generated);
  }
}