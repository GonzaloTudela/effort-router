import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultCatalogPaths = [
  path.join(projectRoot, 'rules', 'php-core.json'),
  path.join(projectRoot, 'rules', 'wordpress.json'),
  path.join(projectRoot, 'rules', 'laravel.json')
];

export async function loadEffectCatalogs(catalogPaths = defaultCatalogPaths) {
  return Promise.all(
    catalogPaths.map(async (catalogPath) => JSON.parse(await readFile(catalogPath, 'utf8')))
  );
}

export function flattenRules(catalogs) {
  return catalogs
    .flatMap((catalog) => catalog.rules.map((rule) => ({
      ...rule,
      catalog_version: catalog.catalog_version,
      framework: catalog.framework,
      language: catalog.language
    })))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function ruleVersions(catalogs) {
  return Object.fromEntries(
    catalogs
      .map((catalog) => [catalog.framework ?? `${catalog.language}-core`, catalog.catalog_version])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function matchRules(rules, nodeKind, candidate) {
  if (!candidate) {
    return [];
  }
  return rules.filter((rule) => {
    if (rule.matcher.node_kind !== nodeKind) {
      return false;
    }
    if (rule.matcher.match === 'exact') {
      return rule.matcher.pattern.localeCompare(candidate, undefined, { sensitivity: 'accent' }) === 0;
    }
    return new RegExp(rule.matcher.pattern, 'i').test(candidate);
  });
}