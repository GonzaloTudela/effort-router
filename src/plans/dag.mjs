export class PlanValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlanValidationError';
    this.details = details;
  }
}

function resourcesFor(task, impactSlice) {
  const resources = new Set(task.conflict_keys);
  for (const target of task.targets) {
    resources.add(`file:${target.path.replaceAll('\\', '/')}`);
    if (target.symbol) {
      resources.add(`symbol:${target.symbol}`);
    }
  }
  if (impactSlice) {
    for (const file of impactSlice.code_profile.files) {
      resources.add(`file:${file.path}`);
    }
    for (const symbolId of impactSlice.selected_symbol_ids) {
      resources.add(`symbol-id:${symbolId}`);
    }
    for (const access of impactSlice.code_profile.state_accesses) {
      if (['external', 'global', 'static'].includes(access.scope)) {
        resources.add(`resource:${access.subject}`);
      }
    }
  }
  return resources;
}

function findCycle(nodesById) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visiting.has(id)) {
      return [...stack.slice(stack.indexOf(id)), id];
    }
    if (visited.has(id)) {
      return null;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of nodesById.get(id).dependencies) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of [...nodesById.keys()].sort()) {
    const cycle = visit(id);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

export function buildTaskDag(taskProfiles, impactSlices = []) {
  const slicesByTask = new Map(impactSlices.map((slice) => [slice.task_id, slice]));
  const nodesById = new Map();
  for (const task of taskProfiles) {
    if (nodesById.has(task.id)) {
      throw new PlanValidationError(`Duplicate task ID: ${task.id}`, { task_id: task.id });
    }
    nodesById.set(task.id, {
      id: task.id,
      dependencies: [...task.dependencies].sort(),
      resources: resourcesFor(task, slicesByTask.get(task.id)),
      task
    });
  }
  for (const node of nodesById.values()) {
    const unknown = node.dependencies.filter((dependency) => !nodesById.has(dependency));
    if (unknown.length > 0) {
      throw new PlanValidationError(`Task ${node.id} has unknown dependencies.`, {
        task_id: node.id,
        unknown_dependencies: unknown
      });
    }
    if (node.dependencies.includes(node.id)) {
      throw new PlanValidationError(`Task ${node.id} depends on itself.`, { task_id: node.id });
    }
  }
  const cycle = findCycle(nodesById);
  if (cycle) {
    throw new PlanValidationError('Task dependencies contain a cycle.', { cycle });
  }

  const conflicts = [];
  const ids = [...nodesById.keys()].sort();
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const left = nodesById.get(ids[leftIndex]);
      const right = nodesById.get(ids[rightIndex]);
      const shared = [...left.resources].filter((resource) => right.resources.has(resource)).sort();
      if (shared.length > 0) {
        conflicts.push({ left: left.id, right: right.id, resources: shared });
      }
    }
  }
  const conflictPairs = new Set(conflicts.flatMap(({ left, right }) => [`${left}\u0000${right}`, `${right}\u0000${left}`]));
  const completed = new Set();
  const remaining = new Set(ids);
  const waves = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => nodesById.get(id).dependencies.every((dependency) => completed.has(dependency)))
      .sort();
    const wave = [];
    for (const id of ready) {
      if (wave.every((other) => !conflictPairs.has(`${id}\u0000${other}`))) {
        wave.push(id);
      }
    }
    if (wave.length === 0) {
      throw new PlanValidationError('No schedulable task wave remains.', { remaining: [...remaining].sort() });
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return {
    schema_version: '1.0.0',
    nodes: ids.map((id) => ({
      id,
      dependencies: nodesById.get(id).dependencies,
      resources: [...nodesById.get(id).resources].sort()
    })),
    conflicts,
    waves
  };
}

export async function executeTaskDag(dag, routeDecisions, executeTask) {
  const decisionsByTask = new Map(routeDecisions.map((decision) => [decision.task_id, decision]));
  const status = new Map();
  const results = [];

  for (let waveIndex = 0; waveIndex < dag.waves.length; waveIndex += 1) {
    const runnable = [];
    for (const taskId of dag.waves[waveIndex]) {
      const node = dag.nodes.find(({ id }) => id === taskId);
      const blockedBy = node.dependencies.filter((dependency) => status.get(dependency) !== 'completed');
      const decision = decisionsByTask.get(taskId);
      if (blockedBy.length > 0) {
        status.set(taskId, 'blocked');
        results.push({ task_id: taskId, status: 'blocked', blocked_by: blockedBy, decision: decision ?? null, result: null });
      } else if (!decision || decision.action !== 'dispatch') {
        status.set(taskId, 'blocked');
        results.push({ task_id: taskId, status: 'blocked', blocked_by: [], decision: decision ?? null, result: null });
      } else {
        runnable.push({ taskId, decision });
      }
    }
    const waveResults = await Promise.all(runnable.map(async ({ taskId, decision }) => {
      try {
        const result = await executeTask(taskId, decision);
        return { task_id: taskId, status: 'completed', blocked_by: [], decision, result };
      } catch (error) {
        return {
          task_id: taskId,
          status: 'failed',
          blocked_by: [],
          decision,
          result: { error: error instanceof Error ? error.message : String(error) }
        };
      }
    }));
    for (const result of waveResults) {
      status.set(result.task_id, result.status);
      results.push(result);
    }
  }
  return results.sort((left, right) => left.task_id.localeCompare(right.task_id));
}