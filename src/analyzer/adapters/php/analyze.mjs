import Engine from 'php-parser';

import { flattenRules, loadEffectCatalogs, matchRules, ruleVersions } from '../../rules.mjs';
import {
  compareLocated,
  deterministicId,
  normalizePath,
  sha256,
  stableStringify
} from '../../stable.mjs';

export const PHP_ANALYZER_VERSION = '1.0.0';

const DECLARATION_KINDS = new Set([
  'class',
  'interface',
  'trait',
  'function',
  'method',
  'closure',
  'arrowfunc'
]);
const EXECUTABLE_SYMBOL_KINDS = new Set(['file', 'function', 'method', 'closure']);
const SKIPPED_AST_KEYS = new Set([
  'comments',
  'docs',
  'errors',
  'leadingComments',
  'loc',
  'tokens',
  'trailingComments'
]);
const KNOWN_PHP_BUILTINS = new Set([
  'abs',
  'array_filter',
  'array_map',
  'array_reduce',
  'array_values',
  'count',
  'explode',
  'implode',
  'intdiv',
  'is_array',
  'is_string',
  'preg_match',
  'preg_replace',
  'sprintf',
  'strtolower',
  'strtoupper',
  'strlen',
  'substr',
  'trim'
]);

function createParser() {
  return new Engine({
    parser: {
      extractDoc: false,
      suppressErrors: true,
      version: '8.4'
    },
    ast: {
      withPositions: true
    }
  });
}

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.kind === 'string';
}

function childNodes(node) {
  const children = [];
  for (const key of Object.keys(node).sort()) {
    if (SKIPPED_AST_KEYS.has(key)) {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) {
          children.push(child);
        }
      }
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function walkScoped(root, visitor) {
  function visit(node, ancestors) {
    visitor(node, ancestors);
    for (const child of childNodes(node)) {
      if (child !== root && DECLARATION_KINDS.has(child.kind)) {
        continue;
      }
      visit(child, [...ancestors, node]);
    }
  }
  visit(root, []);
}

function parserName(node) {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (node.kind === 'variable') {
    return typeof node.name === 'string' ? `$${node.name}` : '<dynamic-variable>';
  }
  if (['identifier', 'name'].includes(node.kind)) {
    return String(node.name ?? '');
  }
  if (node.kind === 'selfreference') {
    return 'self';
  }
  if (node.kind === 'parentreference') {
    return 'parent';
  }
  if (node.kind === 'staticreference') {
    return 'static';
  }
  if (node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup') {
    return `${parserName(node.what)}->${lookupOffset(node.offset)}`;
  }
  if (node.kind === 'staticlookup') {
    return `${parserName(node.what)}::${lookupOffset(node.offset)}`;
  }
  if (node.kind === 'offsetlookup') {
    return `${parserName(node.what)}[${lookupOffset(node.offset)}]`;
  }
  return `<${node.kind}>`;
}

function lookupOffset(node) {
  if (node === null || node === undefined) {
    return '';
  }
  if (['string', 'number'].includes(node.kind)) {
    return `'${String(node.value)}'`;
  }
  if (node.kind === 'identifier') {
    return String(node.name);
  }
  if (node.kind === 'variable' && typeof node.name === 'string') {
    return `$${node.name}`;
  }
  return parserName(node);
}

function unqualifiedName(value) {
  return value.replace(/^\\/, '').split('\\').at(-1);
}

function locationOf(node, filePath) {
  const start = node?.loc?.start ?? { line: 1, column: 0 };
  const end = node?.loc?.end ?? start;
  return {
    path: filePath,
    start_line: Math.max(1, start.line ?? 1),
    end_line: Math.max(start.line ?? 1, end.line ?? start.line ?? 1),
    start_column: start.column === undefined ? null : start.column + 1,
    end_column: end.column === undefined ? null : end.column + 1
  };
}

function typeName(node) {
  if (!node) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(typeName);
  }
  if (['uniontype', 'intersectiontype'].includes(node.kind)) {
    return (node.types ?? []).flatMap(typeName);
  }
  const name = parserName(node).replace(/^\\/, '');
  return name ? [name] : [];
}

function parameterSignature(parameter) {
  const name = parserName(parameter.name ?? parameter);
  const types = typeName(parameter.type);
  const prefix = `${parameter.variadic ? '...' : ''}${parameter.byref ? '&' : ''}`;
  return `${types.length ? `${types.join('|')} ` : ''}${prefix}${name}`.trim();
}

function symbolSignature(node, qualifiedName, kind) {
  if (['class', 'interface', 'trait'].includes(kind)) {
    return `${kind} ${qualifiedName}`;
  }
  if (kind === 'file') {
    return `file ${qualifiedName}`;
  }
  const parameters = (node.arguments ?? []).map(parameterSignature).join(', ');
  const returnTypes = typeName(node.type);
  return `${qualifiedName}(${parameters})${returnTypes.length ? `: ${returnTypes.join('|')}` : ''}`;
}

function controlFlowFor(root) {
  const counts = {
    branch_count: 0,
    loop_count: 0,
    throw_count: 0,
    return_count: 0,
    cyclomatic_complexity: 1
  };
  walkScoped(root, (node) => {
    if (['if', 'case', 'retif', 'matcharm', 'catch'].includes(node.kind)) {
      if (node.kind !== 'case' || node.test !== null) {
        counts.branch_count += 1;
      }
    }
    if (['for', 'foreach', 'while', 'do'].includes(node.kind)) {
      counts.loop_count += 1;
    }
    if (node.kind === 'bin' && ['&&', '||', 'and', 'or'].includes(node.type)) {
      counts.branch_count += 1;
    }
    if (node.kind === 'throw') {
      counts.throw_count += 1;
    }
    if (node.kind === 'return') {
      counts.return_count += 1;
    }
  });
  counts.cyclomatic_complexity += counts.branch_count + counts.loop_count;
  return counts;
}

function collectSymbols(filePath, ast, source) {
  const internalSymbols = [];
  const fileLocation = {
    path: filePath,
    start_line: 1,
    end_line: Math.max(1, source.split(/\r?\n/).length),
    start_column: 1,
    end_column: 1
  };
  const fileSymbol = {
    id: deterministicId('symbol', filePath, 'file'),
    kind: 'file',
    name: filePath,
    qualified_name: filePath,
    location: fileLocation,
    signature: `file ${filePath}`,
    parameters: [],
    return_types: [],
    control_flow: controlFlowFor(ast),
    node: ast,
    class_name: null,
    parent_symbol_id: null
  };
  internalSymbols.push(fileSymbol);

  function collect(node, context) {
    let nextContext = context;
    if (node.kind === 'namespace') {
      nextContext = { ...context, namespace: node.name ?? '' };
    }

    let symbol = null;
    if (['class', 'interface', 'trait'].includes(node.kind)) {
      const name = parserName(node.name);
      const qualifiedName = [nextContext.namespace, name].filter(Boolean).join('\\');
      symbol = makeSymbol(node, node.kind, name, qualifiedName, nextContext.parent_symbol_id, qualifiedName);
      nextContext = {
        ...nextContext,
        class_name: qualifiedName,
        parent_symbol_id: symbol.id
      };
    } else if (node.kind === 'function') {
      const name = parserName(node.name);
      const qualifiedName = [nextContext.namespace, name].filter(Boolean).join('\\');
      symbol = makeSymbol(node, 'function', name, qualifiedName, nextContext.parent_symbol_id, nextContext.class_name);
      nextContext = { ...nextContext, parent_symbol_id: symbol.id };
    } else if (node.kind === 'method') {
      const name = parserName(node.name);
      const qualifiedName = `${nextContext.class_name ?? '<unknown-class>'}::${name}`;
      symbol = makeSymbol(node, 'method', name, qualifiedName, nextContext.parent_symbol_id, nextContext.class_name);
      nextContext = { ...nextContext, parent_symbol_id: symbol.id };
    } else if (['closure', 'arrowfunc'].includes(node.kind)) {
      const loc = locationOf(node, filePath);
      const name = `{closure@${loc.start_line}:${loc.start_column ?? 1}}`;
      const parent = internalSymbols.find(({ id }) => id === nextContext.parent_symbol_id);
      const qualifiedName = `${parent?.qualified_name ?? filePath}::${name}`;
      symbol = makeSymbol(node, 'closure', name, qualifiedName, nextContext.parent_symbol_id, nextContext.class_name);
      nextContext = { ...nextContext, parent_symbol_id: symbol.id };
    }

    for (const child of childNodes(node)) {
      collect(child, nextContext);
    }
  }

  function makeSymbol(node, kind, name, qualifiedName, parentSymbolId, className) {
    const location = locationOf(node, filePath);
    const symbol = {
      id: deterministicId('symbol', filePath, kind, qualifiedName, location.start_line, location.start_column ?? 0),
      kind,
      name,
      qualified_name: qualifiedName,
      location,
      signature: symbolSignature(node, qualifiedName, kind),
      parameters: (node.arguments ?? []).map(parameterSignature),
      return_types: typeName(node.type),
      control_flow: controlFlowFor(node),
      node,
      class_name: className,
      parent_symbol_id: parentSymbolId
    };
    internalSymbols.push(symbol);
    return symbol;
  }

  for (const child of childNodes(ast)) {
    collect(child, {
      namespace: '',
      class_name: null,
      parent_symbol_id: fileSymbol.id
    });
  }
  return internalSymbols;
}

function variableName(node) {
  return node?.kind === 'variable' && typeof node.name === 'string' ? node.name : null;
}

function rootLookupVariable(node) {
  let current = node;
  while (['offsetlookup', 'propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(current?.kind)) {
    current = current.what;
  }
  return variableName(current);
}

function isOutermostLookup(node, ancestors) {
  const parent = ancestors.at(-1);
  return !(
    ['offsetlookup', 'propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(parent?.kind) &&
    parent.what === node
  );
}

function accessMode(node, ancestors) {
  let child = node;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index];
    if (parent.kind === 'assign' && parent.left === child) {
      return parent.operator === '=' ? 'write' : 'read_write';
    }
    if (['pre', 'post'].includes(parent.kind) && parent.what === child) {
      return 'read_write';
    }
    if (parent.kind === 'unset' && (parent.variables ?? parent.items ?? []).includes(child)) {
      return 'write';
    }
    if (!['offsetlookup', 'propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(parent.kind)) {
      break;
    }
    child = parent;
  }
  return 'read';
}

function effectKindsForState(scope, access) {
  if (scope === 'global') {
    return access === 'read_write'
      ? ['global_state_read', 'global_state_write']
      : [`global_state_${access}`];
  }
  if (scope === 'static') {
    return access === 'read_write'
      ? ['static_state_read', 'static_state_write']
      : [`static_state_${access}`];
  }
  return [];
}

function invocation(node) {
  if (node.kind === 'new') {
    const callee = parserName(node.what).replace(/^\\/, '');
    return {
      callKind: 'constructor',
      callee,
      candidates: [callee],
      dynamicTarget: node.what?.kind === 'variable'
    };
  }
  if (node.kind !== 'call') {
    return null;
  }
  const callee = parserName(node.what).replace(/^\\/, '');
  const isLookup = ['propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(node.what?.kind);
  const candidates = [callee];
  if (isLookup) {
    candidates.push(callee.split(/->|::/).at(-1));
  }
  return {
    callKind: isLookup ? 'method_call' : 'call',
    callee: callee || '<dynamic-call>',
    candidates: [...new Set(candidates.filter(Boolean))],
    dynamicTarget: node.what?.kind === 'variable' || callee.includes('<dynamic')
  };
}

function rulesForInvocation(rules, details) {
  const matched = details.candidates.flatMap((candidate) => matchRules(rules, details.callKind, candidate));
  if (details.callKind === 'constructor') {
    matched.push(...details.candidates.flatMap((candidate) => matchRules(rules, 'class_reference', candidate)));
  }
  return [...new Map(matched.map((rule) => [rule.id, rule])).values()];
}

function parseErrorText(error) {
  const line = error.lineNumber ?? error.loc?.start?.line;
  return `${line ? `line ${line}: ` : ''}${error.message ?? String(error)}`;
}

function publicSymbol(symbol) {
  return {
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    qualified_name: symbol.qualified_name,
    location: symbol.location,
    signature: symbol.signature,
    parameters: symbol.parameters,
    return_types: symbol.return_types,
    control_flow: symbol.control_flow
  };
}

export async function analyzePhpFiles(inputFiles, options = {}) {
  const catalogs = options.catalogs ?? await loadEffectCatalogs(options.catalogPaths);
  const rules = flattenRules(catalogs);
  const parser = createParser();
  const normalizedFiles = inputFiles
    .map(({ path: filePath, source }) => ({ path: normalizePath(filePath), source: String(source) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const parsedFiles = [];
  const internalSymbols = [];
  const evidence = [];
  const evidenceIds = new Set();

  function addEvidence({ source = 'static', kind, location = null, ruleId = null, detail, confidence = 1 }) {
    const id = deterministicId(
      'evidence',
      source,
      kind,
      location?.path ?? '',
      location?.start_line ?? 0,
      location?.start_column ?? 0,
      ruleId ?? '',
      detail
    );
    if (!evidenceIds.has(id)) {
      evidenceIds.add(id);
      evidence.push({ id, source, kind, location, rule_id: ruleId, detail, confidence });
    }
    return id;
  }

  for (const file of normalizedFiles) {
    let ast;
    let errors = [];
    try {
      ast = parser.parseCode(file.source, file.path);
      errors = (ast.errors ?? []).map(parseErrorText);
    } catch (error) {
      errors = [parseErrorText(error)];
      ast = { kind: 'program', children: [], loc: null, errors: [] };
    }
    const hash = sha256(file.source);
    parsedFiles.push({
      path: file.path,
      hash,
      parsed: errors.length === 0,
      parse_errors: errors,
      ast,
      source: file.source
    });
    if (errors.length > 0) {
      for (const error of errors) {
        addEvidence({
          kind: 'parse_error',
          location: { path: file.path, start_line: 1, end_line: 1, start_column: null, end_column: null },
          ruleId: 'php.ast.parse-error',
          detail: error,
          confidence: 1
        });
      }
    }
    const symbols = collectSymbols(file.path, ast, file.source);
    internalSymbols.push(...symbols);
    for (const symbol of symbols) {
      addEvidence({
        kind: 'symbol',
        location: symbol.location,
        ruleId: 'php.ast.symbol',
        detail: `${symbol.kind} ${symbol.qualified_name}`,
        confidence: 1
      });
    }
  }

  const calls = [];
  const stateAccesses = [];
  const effects = [];
  const stateKeys = new Set();
  const effectKeys = new Set();

  function addState(symbol, subject, scope, access, node, ruleId) {
    const location = locationOf(node, symbol.location.path);
    const key = [symbol.id, subject, scope, access, location.start_line, location.start_column].join('|');
    if (stateKeys.has(key)) {
      return;
    }
    stateKeys.add(key);
    stateAccesses.push({
      id: deterministicId('state', key),
      symbol_id: symbol.id,
      subject,
      scope,
      access,
      location
    });
    addEvidence({
      kind: 'state_access',
      location,
      ruleId,
      detail: `${access} ${scope} state ${subject}`,
      confidence: 1
    });
  }

  function addEffect(symbol, kind, operation, node, ruleId) {
    const location = locationOf(node, symbol.location.path);
    const key = [symbol.id, kind, operation, ruleId, location.start_line, location.start_column].join('|');
    if (effectKeys.has(key)) {
      return;
    }
    effectKeys.add(key);
    effects.push({
      id: deterministicId('effect', key),
      symbol_id: symbol.id,
      kind,
      operation,
      location,
      rule_id: ruleId
    });
    addEvidence({
      kind: 'effect',
      location,
      ruleId,
      detail: `${kind} via ${operation}`,
      confidence: 1
    });
  }

  function applyRules(symbol, matchedRules, operation, node) {
    for (const rule of matchedRules) {
      for (const effect of rule.effects) {
        addEffect(symbol, effect, operation, node, rule.id);
      }
      if (rule.state_scope && rule.state_access) {
        addState(symbol, rule.resource ?? operation, rule.state_scope, rule.state_access, node, rule.id);
      }
    }
  }

  for (const symbol of internalSymbols.filter(({ kind }) => EXECUTABLE_SYMBOL_KINDS.has(kind))) {
    const globalNames = new Set();
    const staticNames = new Set();
    walkScoped(symbol.node, (node) => {
      if (node.kind === 'global') {
        for (const item of node.items ?? []) {
          const name = variableName(item);
          if (name) {
            globalNames.add(name);
          }
        }
        addEvidence({
          kind: 'global_declaration',
          location: locationOf(node, symbol.location.path),
          ruleId: 'php.global-declaration',
          detail: `Declares global variables: ${(node.items ?? []).map(parserName).join(', ')}`,
          confidence: 1
        });
      }
      if (node.kind === 'static') {
        for (const item of node.variables ?? []) {
          const name = variableName(item.variable);
          if (name) {
            staticNames.add(name);
          }
        }
      }
    });

    walkScoped(symbol.node, (node, ancestors) => {
      const details = invocation(node);
      if (details) {
        const matchedRules = rulesForInvocation(rules, details);
        const dynamic = details.dynamicTarget || matchedRules.some(({ id }) => id === 'php.dynamic-call');
        const location = locationOf(node, symbol.location.path);
        const call = {
          id: deterministicId('call', symbol.id, details.callee, location.start_line, location.start_column ?? 0),
          caller_symbol_id: symbol.id,
          callee: details.callee,
          resolved_symbol_id: null,
          resolved: false,
          dynamic,
          location,
          call_kind: details.callKind,
          candidates: details.candidates,
          matched_rules: matchedRules.map(({ id }) => id)
        };
        calls.push(call);
        addEvidence({
          kind: 'call',
          location,
          ruleId: 'php.ast.call',
          detail: `${details.callKind} ${details.callee}`,
          confidence: 1
        });
        applyRules(symbol, matchedRules, details.callee, node);
      }

      if (['echo', 'print', 'eval', 'include'].includes(node.kind)) {
        const candidate = node.kind === 'print' ? 'echo' : node.kind;
        applyRules(symbol, matchRules(rules, 'language_construct', candidate), candidate, node);
      }

      if (node.kind === 'offsetlookup' && isOutermostLookup(node, ancestors)) {
        const rootName = rootLookupVariable(node);
        if (rootName === 'GLOBALS' || globalNames.has(rootName)) {
          const access = accessMode(node, ancestors);
          const subject = rootName === 'GLOBALS' ? parserName(node) : `$${rootName}`;
          const ruleId = rootName === 'GLOBALS' ? 'php.globals-array' : 'php.global-declaration';
          addState(symbol, subject, 'global', access, node, ruleId);
          for (const effect of effectKindsForState('global', access)) {
            addEffect(symbol, effect, subject, node, ruleId);
          }
        }
      } else if (node.kind === 'variable') {
        const parent = ancestors.at(-1);
        const name = variableName(node);
        if (parent?.kind !== 'global' && parent?.kind !== 'static' && name !== 'GLOBALS') {
          const access = accessMode(node, ancestors);
          if (globalNames.has(name) && !['offsetlookup', 'propertylookup', 'nullsafepropertylookup'].includes(parent?.kind)) {
            const subject = `$${name}`;
            addState(symbol, subject, 'global', access, node, 'php.global-declaration');
            for (const effect of effectKindsForState('global', access)) {
              addEffect(symbol, effect, subject, node, 'php.global-declaration');
            }
          } else if (staticNames.has(name)) {
            const subject = `$${name}`;
            addState(symbol, subject, 'static', access, node, 'php.ast.static-variable');
            for (const effect of effectKindsForState('static', access)) {
              addEffect(symbol, effect, subject, node, 'php.ast.static-variable');
            }
          }
        }
      }

      if (['propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(node.kind)) {
        const parent = ancestors.at(-1);
        if (!(parent?.kind === 'call' && parent.what === node) && isOutermostLookup(node, ancestors)) {
          const scope = node.kind === 'staticlookup' ? 'static' : 'property';
          const access = accessMode(node, ancestors);
          const subject = parserName(node);
          addState(symbol, subject, scope, access, node, 'php.ast.property-access');
          for (const effect of effectKindsForState(scope, access)) {
            addEffect(symbol, effect, subject, node, 'php.ast.property-access');
          }
        }
      }
    });
  }

  const symbolsByQualifiedName = new Map();
  const symbolsByName = new Map();
  for (const symbol of internalSymbols) {
    symbolsByQualifiedName.set(symbol.qualified_name.toLowerCase(), symbol);
    const key = symbol.name.toLowerCase();
    if (!symbolsByName.has(key)) {
      symbolsByName.set(key, []);
    }
    symbolsByName.get(key).push(symbol);
  }

  const dependencies = [];
  for (const call of calls) {
    const caller = internalSymbols.find(({ id }) => id === call.caller_symbol_id);
    const normalizedCallee = call.callee.replace(/^\\/, '').toLowerCase();
    let resolvedSymbol = symbolsByQualifiedName.get(normalizedCallee) ?? null;
    if (!resolvedSymbol && !normalizedCallee.includes('->') && !normalizedCallee.includes('::')) {
      const named = symbolsByName.get(unqualifiedName(normalizedCallee));
      if (named?.length === 1) {
        resolvedSymbol = named[0];
      }
    }
    if (!resolvedSymbol && caller?.class_name) {
      const methodName = call.callee.split(/->|::/).at(-1);
      if (call.callee.startsWith('$this->') || call.callee.startsWith('self::') || call.callee.startsWith('static::')) {
        resolvedSymbol = symbolsByQualifiedName.get(`${caller.class_name}::${methodName}`.toLowerCase()) ?? null;
      }
    }
    const knownRule = call.matched_rules.length > 0;
    const builtin = KNOWN_PHP_BUILTINS.has(unqualifiedName(normalizedCallee));
    call.resolved_symbol_id = resolvedSymbol?.id ?? null;
    call.resolved = Boolean(resolvedSymbol || knownRule || builtin) && !call.dynamic;

    let kind = 'package';
    if (resolvedSymbol) {
      kind = 'internal';
    } else if (call.matched_rules.some((id) => id.startsWith('wordpress.') || id.startsWith('laravel.'))) {
      kind = 'framework';
    } else if (knownRule || builtin) {
      kind = 'runtime';
    }
    dependencies.push({
      id: deterministicId('dependency', call.id, kind, call.callee),
      from_symbol_id: call.caller_symbol_id,
      target: call.callee,
      kind,
      resolved: call.resolved
    });
  }

  const testFiles = new Map();
  const testSymbolIds = new Set(
    internalSymbols
      .filter((symbol) => (
        /(^|\/)tests?\//i.test(symbol.location.path) ||
        /(?:^|\\)(?:Test|.*Test)$/.test(symbol.class_name ?? '') ||
        /^test/i.test(symbol.name)
      ))
      .map(({ id }) => id)
  );
  for (const symbol of internalSymbols.filter(({ id }) => testSymbolIds.has(id))) {
    if (!testFiles.has(symbol.location.path)) {
      testFiles.set(symbol.location.path, new Set());
    }
    for (const call of calls.filter(({ caller_symbol_id }) => caller_symbol_id === symbol.id)) {
      if (call.resolved_symbol_id && !testSymbolIds.has(call.resolved_symbol_id)) {
        testFiles.get(symbol.location.path).add(call.resolved_symbol_id);
      }
    }
  }
  const tests = [...testFiles.entries()]
    .map(([filePath, symbolIds]) => ({
      path: filePath,
      symbol_ids: [...symbolIds].sort(),
      commands: [`vendor/bin/phpunit ${filePath}`]
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const publicCalls = calls
    .map(({ call_kind: _callKind, candidates: _candidates, matched_rules: _matchedRules, ...call }) => call)
    .sort(compareLocated);
  const publicFiles = parsedFiles
    .map(({ ast: _ast, source: _source, ...file }) => file)
    .sort((left, right) => left.path.localeCompare(right.path));
  const publicSymbols = internalSymbols.map(publicSymbol).sort(compareLocated);
  stateAccesses.sort(compareLocated);
  effects.sort(compareLocated);
  dependencies.sort((left, right) => (
    left.from_symbol_id.localeCompare(right.from_symbol_id) ||
    left.target.localeCompare(right.target) ||
    left.id.localeCompare(right.id)
  ));
  evidence.sort(compareLocated);
  const unresolvedCallIds = publicCalls.filter(({ resolved }) => !resolved).map(({ id }) => id).sort();
  const dynamicConstructs = new Set([
    ...publicCalls.filter(({ dynamic }) => dynamic).map(({ id }) => id),
    ...effects.filter(({ kind }) => kind === 'dynamic_code').map(({ id }) => id)
  ]).size;
  return {
    schema_version: '1.0.0',
    profile_id: deterministicId(
      'code-profile',
      ...normalizedFiles.flatMap((file) => [file.path, sha256(file.source)]),
      PHP_ANALYZER_VERSION,
      stableStringify(ruleVersions(catalogs))
    ),
    analyzer: {
      name: 'effort-router-php',
      version: PHP_ANALYZER_VERSION,
      language: 'php',
      rule_versions: ruleVersions(catalogs)
    },
    source_hash: sha256(normalizedFiles.map((file) => `${file.path}\u0000${file.source}`).join('\u0000')),
    files: publicFiles,
    symbols: publicSymbols,
    calls: publicCalls,
    state_accesses: stateAccesses,
    effects,
    dependencies,
    tests,
    coverage: {
      files_total: publicFiles.length,
      files_parsed: publicFiles.filter(({ parsed }) => parsed).length,
      calls_total: publicCalls.length,
      calls_resolved: publicCalls.filter(({ resolved }) => resolved).length,
      unresolved_call_ids: unresolvedCallIds,
      dynamic_constructs: dynamicConstructs,
      bounded: publicFiles.every(({ parsed }) => parsed)
    },
    evidence
  };
}