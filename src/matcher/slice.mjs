import { compareLocated, deterministicId, normalizePath, sha256 } from '../analyzer/stable.mjs';

function isPathWithinRoots(filePath, roots) {
  if (roots.length === 0) {
    return true;
  }
  return roots.some((root) => filePath === root || filePath.startsWith(`${root.replace(/\/$/, '')}/`));
}

function symbolsForTarget(target, profile) {
  const targetPath = normalizePath(target.path);
  const fileSymbols = profile.symbols.filter(({ location }) => location.path === targetPath);
  if (target.symbol === null) {
    const declarations = fileSymbols.filter(({ kind }) => kind !== 'file');
    return declarations.length > 0 ? declarations : fileSymbols;
  }
  const requested = target.symbol.toLowerCase().replace(/^\\/, '');
  return fileSymbols.filter((symbol) => (
    symbol.name.toLowerCase() === requested ||
    symbol.qualified_name.toLowerCase().replace(/^\\/, '') === requested
  ));
}

export function resolveTaskTargets(taskProfile, codeProfile) {
  const symbolIds = new Set();
  const unresolved = [];
  for (const target of taskProfile.targets) {
    const matches = symbolsForTarget(target, codeProfile);
    if (matches.length === 0) {
      unresolved.push({ ...target, reason: 'not_found' });
      continue;
    }
    if (target.symbol !== null && matches.length > 1) {
      unresolved.push({ ...target, reason: 'ambiguous_symbol' });
      continue;
    }
    for (const symbol of matches) {
      symbolIds.add(symbol.id);
    }
  }
  return {
    symbol_ids: [...symbolIds].sort(),
    unresolved
  };
}

function buildGraph(profile) {
  const outgoing = new Map();
  const incoming = new Map();
  for (const symbol of profile.symbols) {
    outgoing.set(symbol.id, new Set());
    incoming.set(symbol.id, new Set());
  }
  for (const call of profile.calls) {
    if (!call.resolved_symbol_id) {
      continue;
    }
    outgoing.get(call.caller_symbol_id)?.add(call.resolved_symbol_id);
    incoming.get(call.resolved_symbol_id)?.add(call.caller_symbol_id);
  }
  return { outgoing, incoming };
}

function buildResourceGraph(profile) {
  const symbolsByResource = new Map();
  for (const access of profile.state_accesses) {
    if (!['external', 'global', 'static'].includes(access.scope)) {
      continue;
    }
    if (!symbolsByResource.has(access.subject)) {
      symbolsByResource.set(access.subject, new Set());
    }
    symbolsByResource.get(access.subject).add(access.symbol_id);
  }
  const resourcesBySymbol = new Map();
  for (const [resource, symbolIds] of symbolsByResource) {
    for (const symbolId of symbolIds) {
      if (!resourcesBySymbol.has(symbolId)) {
        resourcesBySymbol.set(symbolId, new Set());
      }
      resourcesBySymbol.get(symbolId).add(resource);
    }
  }
  return { resourcesBySymbol, symbolsByResource };
}

function addNeighbor({
  neighborId,
  fromId,
  relation,
  depth,
  selected,
  queue,
  symbolsById,
  allowedRoots,
  expansion,
  maxSymbols
}) {
  if (selected.has(neighborId)) {
    return { limited: false };
  }
  const neighbor = symbolsById.get(neighborId);
  if (!neighbor || !isPathWithinRoots(neighbor.location.path, allowedRoots)) {
    return { limited: false };
  }
  if (selected.size >= maxSymbols) {
    return { limited: true };
  }
  selected.add(neighborId);
  queue.push({ symbolId: neighborId, depth });
  expansion.push({ from_symbol_id: fromId, to_symbol_id: neighborId, relation, depth });
  return { limited: false };
}

function expandSlice(taskProfile, codeProfile, targetIds, options) {
  const maxDepth = options.maxDepth ?? 8;
  const maxSymbols = options.maxSymbols ?? 500;
  const allowedRoots = taskProfile.context_roots.map(normalizePath);
  const symbolsById = new Map(codeProfile.symbols.map((symbol) => [symbol.id, symbol]));
  const { outgoing, incoming } = buildGraph(codeProfile);
  const { resourcesBySymbol, symbolsByResource } = buildResourceGraph(codeProfile);
  const selected = new Set(targetIds);
  const expansion = [];
  const queue = targetIds.map((symbolId) => ({ symbolId, depth: 0 }));
  let limited = false;

  while (queue.length > 0) {
    const { symbolId, depth } = queue.shift();
    if (depth >= maxDepth) {
      const hasFurtherEdges = (outgoing.get(symbolId)?.size ?? 0) > 0 || (incoming.get(symbolId)?.size ?? 0) > 0;
      limited ||= hasFurtherEdges && ['callers', 'architecture'].includes(taskProfile.change_surface);
      continue;
    }

    const neighbors = [];
    if (taskProfile.change_surface === 'body') {
      if (depth === 0) {
        neighbors.push(...[...(outgoing.get(symbolId) ?? [])].map((id) => [id, 'direct_dependency']));
      }
    } else if (taskProfile.change_surface === 'signature') {
      if (depth === 0) {
        neighbors.push(...[...(incoming.get(symbolId) ?? [])].map((id) => [id, 'direct_caller']));
      }
    } else if (taskProfile.change_surface === 'callers') {
      neighbors.push(...[...(incoming.get(symbolId) ?? [])].map((id) => [id, 'caller']));
    } else if (taskProfile.change_surface === 'data_contract') {
      if (depth === 0) {
        neighbors.push(...[...(outgoing.get(symbolId) ?? [])].map((id) => [id, 'producer_or_dependency']));
        neighbors.push(...[...(incoming.get(symbolId) ?? [])].map((id) => [id, 'consumer_or_caller']));
      }
      for (const resource of resourcesBySymbol.get(symbolId) ?? []) {
        neighbors.push(...[...(symbolsByResource.get(resource) ?? [])].map((id) => [id, `shared_resource:${resource}`]));
      }
    } else if (taskProfile.change_surface === 'architecture') {
      neighbors.push(...[...(outgoing.get(symbolId) ?? [])].map((id) => [id, 'dependency']));
      neighbors.push(...[...(incoming.get(symbolId) ?? [])].map((id) => [id, 'dependent']));
      for (const resource of resourcesBySymbol.get(symbolId) ?? []) {
        neighbors.push(...[...(symbolsByResource.get(resource) ?? [])].map((id) => [id, `shared_resource:${resource}`]));
      }
    }

    for (const [neighborId, relation] of neighbors.sort(([left], [right]) => left.localeCompare(right))) {
      const result = addNeighbor({
        neighborId,
        fromId: symbolId,
        relation,
        depth: depth + 1,
        selected,
        queue,
        symbolsById,
        allowedRoots,
        expansion,
        maxSymbols
      });
      limited ||= result.limited;
    }
  }

  return {
    selectedIds: selected,
    expansion: expansion.sort((left, right) => (
      left.depth - right.depth ||
      left.from_symbol_id.localeCompare(right.from_symbol_id) ||
      left.to_symbol_id.localeCompare(right.to_symbol_id) ||
      left.relation.localeCompare(right.relation)
    )),
    limited
  };
}

function locationInside(location, symbolLocation) {
  return (
    location.path === symbolLocation.path &&
    location.start_line >= symbolLocation.start_line &&
    location.end_line <= symbolLocation.end_line
  );
}

function subsetCodeProfile(codeProfile, selectedIds, bounded) {
  const symbols = codeProfile.symbols.filter(({ id }) => selectedIds.has(id)).sort(compareLocated);
  const symbolLocations = symbols.map(({ location }) => location);
  const filePaths = new Set(symbols.map(({ location }) => location.path));
  const calls = codeProfile.calls
    .filter(({ caller_symbol_id }) => selectedIds.has(caller_symbol_id))
    .sort(compareLocated);
  const stateAccesses = codeProfile.state_accesses
    .filter(({ symbol_id }) => selectedIds.has(symbol_id))
    .sort(compareLocated);
  const effects = codeProfile.effects
    .filter(({ symbol_id }) => selectedIds.has(symbol_id))
    .sort(compareLocated);
  const dependencies = codeProfile.dependencies
    .filter(({ from_symbol_id }) => selectedIds.has(from_symbol_id))
    .sort((left, right) => (
      left.from_symbol_id.localeCompare(right.from_symbol_id) ||
      left.target.localeCompare(right.target) ||
      left.id.localeCompare(right.id)
    ));
  const tests = codeProfile.tests
    .filter(({ symbol_ids }) => symbol_ids.some((id) => selectedIds.has(id)))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const test of tests) {
    filePaths.add(test.path);
  }
  const files = codeProfile.files
    .filter(({ path }) => filePaths.has(path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const evidence = codeProfile.evidence
    .filter(({ location }) => (
      location === null || symbolLocations.some((symbolLocation) => locationInside(location, symbolLocation))
    ))
    .sort(compareLocated);
  const unresolvedCallIds = calls.filter(({ resolved }) => !resolved).map(({ id }) => id).sort();
  return {
    schema_version: codeProfile.schema_version,
    profile_id: deterministicId('code-slice', codeProfile.profile_id, ...[...selectedIds].sort()),
    analyzer: codeProfile.analyzer,
    source_hash: sha256(`${codeProfile.source_hash}\u0000${[...selectedIds].sort().join('\u0000')}`),
    files,
    symbols,
    calls,
    state_accesses: stateAccesses,
    effects,
    dependencies,
    tests,
    coverage: {
      files_total: files.length,
      files_parsed: files.filter(({ parsed }) => parsed).length,
      calls_total: calls.length,
      calls_resolved: calls.filter(({ resolved }) => resolved).length,
      unresolved_call_ids: unresolvedCallIds,
      dynamic_constructs: new Set([
        ...calls.filter(({ dynamic }) => dynamic).map(({ id }) => id),
        ...effects.filter(({ kind }) => kind === 'dynamic_code').map(({ id }) => id)
      ]).size,
      bounded
    },
    evidence
  };
}

export function buildImpactSlice(taskProfile, codeProfile, options = {}) {
  const resolution = resolveTaskTargets(taskProfile, codeProfile);
  const expanded = expandSlice(taskProfile, codeProfile, resolution.symbol_ids, options);
  const selectedCalls = codeProfile.calls.filter(({ caller_symbol_id }) => expanded.selectedIds.has(caller_symbol_id));
  const selectedFilePaths = new Set(
    codeProfile.symbols
      .filter(({ id }) => expanded.selectedIds.has(id))
      .map(({ location }) => location.path)
  );
  const parseFailure = codeProfile.files.some(({ path, parsed }) => selectedFilePaths.has(path) && !parsed);
  const unresolvedOrDynamic = selectedCalls.some(({ resolved, dynamic }) => !resolved || dynamic);
  const bounded = (
    resolution.unresolved.length === 0 &&
    !expanded.limited &&
    !parseFailure &&
    !unresolvedOrDynamic
  );
  const profile = subsetCodeProfile(codeProfile, expanded.selectedIds, bounded);
  return {
    schema_version: '1.0.0',
    slice_id: deterministicId('impact-slice', taskProfile.id, profile.profile_id, taskProfile.change_surface),
    task_id: taskProfile.id,
    change_surface: taskProfile.change_surface,
    target_symbol_ids: resolution.symbol_ids,
    selected_symbol_ids: [...expanded.selectedIds].sort(),
    unresolved_targets: resolution.unresolved,
    expansion: expanded.expansion,
    bounded,
    limits: {
      max_depth: options.maxDepth ?? 8,
      max_symbols: options.maxSymbols ?? 500,
      limit_reached: expanded.limited
    },
    code_profile: profile
  };
}