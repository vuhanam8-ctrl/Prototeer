const unityTriggers = new Set(['interact', 'behavior', 'tick', 'contact']);
const unityEffects = new Set(['stat', 'tag', 'untag']);
const unityConditions = new Set(['always', 'stat', 'tag']);
const unityComposites = new Set(['selector', 'sequence', 'utility']);
const unityActions = new Set(['wait', 'idle', 'rule', 'chooseTarget', 'moveTarget']);
const unityComparisonOperators = new Set(['<', '<=', '>', '>=', '==', '!=']);
const unityActionLabels = {
  wait: 'Wait', idle: 'Idle', rule: 'Run rule', chooseTarget: 'Choose point',
  moveTarget: 'Move to stored point', rememberTarget: 'Remember point',
  clearTarget: 'Clear stored point', clearHistory: 'Clear history',
  seek: 'Seek object', interact: 'Interact', wander: 'Wander', patrol: 'Patrol',
  directive: 'Follow director input', zone: 'Move to zone', acknowledge: 'Acknowledge message',
};

function unityFields(source, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}

function unityGraph(tool, includeTrees, addIssue, references) {
  if (!includeTrees) return {brainEnabled: false, brain: [], edges: []};
  if (!tool.brainEnabled) {
    if ((tool.decisions ?? []).some(decision => decision.enabled)) {
      addIssue('Standalone utility decisions cannot be exported. Use a behavior tree or clear Include behavior trees.');
    }
    return {brainEnabled: false, brain: [], edges: []};
  }

  const nodes = new Map();
  for (const node of tool.brain ?? []) {
    if (nodes.has(node.id)) addIssue('Two behavior nodes have the same ID.');
    nodes.set(node.id, node);
  }
  if (!nodes.has('root')) addIssue('The behavior tree needs a root node.');

  const edges = [];
  const incoming = new Set();
  const children = new Map();
  for (const [from, to] of tool.edges ?? []) {
    if (!nodes.has(from) || !nodes.has(to) || !unityComposites.has(nodes.get(from)?.type)) {
      addIssue('The behavior tree has an invalid connection.');
      continue;
    }
    if (to === 'root' || incoming.has(to)) {
      addIssue(`“${nodes.get(to).label}” must have only one parent in Unity.`);
      continue;
    }
    incoming.add(to);
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(nodes.get(to));
    edges.push([from, to]);
  }

  const reachable = new Set();
  function visit(id) {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const child of children.get(id) ?? []) visit(child.id);
  }
  if (nodes.has('root')) visit('root');
  if (reachable.size !== nodes.size) addIssue('Connect or remove unconnected behavior nodes before exporting.');

  for (const [id, node] of nodes) {
    const problem = message => addIssue(`Node “${node.label}”. ${message}`);
    if (unityComposites.has(node.type) && !(children.get(id)?.length)) {
      problem('Connect at least one child.');
    }
    switch (node.type) {
      case 'utility':
        for (const branch of children.get(id) ?? []) {
          if (branch.scoreZone || branch.messageKey) {
            addIssue(`Branch “${branch.label}”. Unity supports constant and stat scores. Remove zone or message scoring.`);
          }
          const stat = branch.scoreStat ?? branch.stat;
          if (stat) references.stat(stat, problem);
        }
        break;
      case 'selector':
        break;
      case 'sequence':
        if (node.sequenceMode !== 'memory') {
          problem('Select a memory sequence for Unity export.');
        }
        break;
      case 'condition':
        if (node.condition === 'stat') {
          references.stat(node.stat, problem);
          if (!unityComparisonOperators.has(node.op)) problem('Choose a supported stat comparison.');
        } else if (node.condition === 'tag') {
          references.tag(node.tag, problem);
        } else {
          problem('Unity supports stat and tag conditions for this export.');
        }
        break;
      case 'action':
        unityCheckAction(node, tool, problem, references);
        break;
      default:
        problem('This node type cannot be exported to Unity yet.');
    }
  }

  const nodeKeys = [
    'id', 'label', 'description', 'type', 'x', 'y', 'condition', 'stat', 'tag', 'tagMode',
    'op', 'threshold', 'action', 'ruleId', 'ruleNoopSuccess', 'waitMin', 'waitMax',
    'resetOnInterrupt', 'sequenceMode', 'scoreStat', 'direction', 'weight',
    'commitRunning', 'commitTicks', 'interruptMargin', 'slot', 'selectionSource',
    'selectionZones', 'zoneRelation', 'choosePolicy', 'minTravel', 'requireLiveInput',
  ];
  return {
    brainEnabled: true,
    brain: [...nodes.values()].map(node => {
      const fields = unityFields(node, nodeKeys);
      if (node.type === 'condition' && node.condition === 'tag') fields.tagMode ??= 'present';
      if (node.type === 'action' && node.action === 'chooseTarget') {
        fields.selectionSource ??= 'zones';
        fields.selectionZones = [...new Set(node.selectionZones)];
      }
      return fields;
    }),
    edges,
  };
}

function unityCheckAction(node, tool, addIssue, references) {
  if (!unityActions.has(node.action)) {
    addIssue(`${unityActionLabels[node.action] ?? 'This action'} cannot be exported to Unity yet.`);
    return;
  }
  if (node.action === 'rule' && !tool.rules.some(rule => rule.id === node.ruleId)) {
    addIssue('Choose an interaction rule.');
  }
  if (node.action === 'wait') {
    const min = node.waitMin ?? 2;
    const max = node.waitMax ?? 6;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 1000) {
      addIssue('Choose a valid wait range from 0 to 1000 ticks.');
    }
  }
  if (node.action === 'chooseTarget') {
    if ((node.selectionSource ?? 'zones') !== 'zones' || !node.selectionZones?.length) {
      addIssue('Choose points from named zones.');
      return;
    }
    if ((node.zoneRelation ?? 'any') !== 'any' || (node.avoidRecent ?? 0) > 0) {
      addIssue('Use any location and set Avoid recent to 0.');
    }
    for (const zoneId of node.selectionZones) references.zone(zoneId, addIssue);
  }
  if (node.action === 'moveTarget') {
    if (!tool.mobile) addIssue('Turn on Can move for this object type.');
    if ((node.routeStyle ?? 'shortest') !== 'shortest' || node.diagonal) {
      addIssue('Use the default route settings. Unity handles the route.');
    }
  }
}

function unityRules(tool, addIssue, references) {
  const ruleKeys = [
    'id', 'name', 'description', 'enabled', 'trigger', 'selfTag', 'otherTag', 'conditionTag',
    'tagMode', 'condition', 'conditionTarget', 'stat', 'op', 'threshold',
    'target', 'effect', 'effectStat', 'amount', 'tag',
  ];
  const ruleIds = new Set();
  return tool.rules.map(rule => {
    const problem = message => addIssue(`Rule “${rule.name}”. ${message}`);
    if (ruleIds.has(rule.id)) problem('This rule shares an ID with another rule. Recreate it before exporting.');
    ruleIds.add(rule.id);
    if (rule.enabled) {
      if (!unityTriggers.has(rule.trigger)) problem('This trigger cannot be exported to Unity yet.');
      if (!unityConditions.has(rule.condition)) problem('Use an always, stat, or tag condition.');
      if (!unityEffects.has(rule.effect)) problem('Use a stat change, add tag, or remove tag effect.');
    }
    if (rule.selfTag) references.tag(rule.selfTag, problem);
    if (rule.otherTag) references.tag(rule.otherTag, problem);
    if (rule.condition === 'stat' && (rule.enabled || rule.stat)) {
      references.stat(rule.stat, problem);
      if (rule.enabled && !unityComparisonOperators.has(rule.op)) problem('Choose a supported stat comparison.');
    }
    if (rule.condition === 'tag' && (rule.enabled || rule.conditionTag)) references.tag(rule.conditionTag, problem);
    if (rule.effect === 'stat' && (rule.enabled || rule.effectStat)) references.stat(rule.effectStat, problem);
    if (['tag', 'untag'].includes(rule.effect) && (rule.enabled || rule.tag)) references.tag(rule.tag, problem);
    const fields = unityFields(rule, ruleKeys);
    if (rule.condition === 'tag') fields.tagMode ??= 'present';
    return fields;
  });
}

export function compileUnityExport(world, {toolIds, includeTrees = true} = {}) {
  const issues = new Set();
  const selectedIds = new Set(toolIds ?? world.tools.map(tool => tool.id));
  const selected = world.tools.filter(tool => selectedIds.has(tool.id));
  if (!selected.length) issues.add('Select at least one object type.');
  if (selected.length !== selectedIds.size) issues.add('An object type was removed. Open Export to Unity again.');

  const required = {stat: new Set(), tag: new Set(), zone: new Set()};
  const known = {
    stat: new Map(world.stats.map(stat => [stat.id, stat])),
    tag: new Map(world.tagDefs.map(tag => [tag.id, tag])),
    zone: new Map(world.zones.map(zone => [zone.id, zone])),
  };
  function use(kind, id, problem) {
    const definition = known[kind].get(id);
    if (!definition) problem(`Choose an existing ${kind}.`);
    else if (kind === 'zone' && !definition.enabled) problem(`Enable zone “${definition.name}” before exporting.`);
    else required[kind].add(id);
  }
  const references = Object.fromEntries(Object.keys(known).map(kind => [
    kind, (id, problem) => use(kind, id, problem),
  ]));

  const tools = selected.map(tool => {
    const problem = message => issues.add(`“${tool.name}”. ${message}`);
    const statIds = [...tool.statIds];
    const tags = [...tool.tags];
    const allowedMovementZones = [...(tool.allowedMovementZones ?? [])];
    statIds.forEach(id => references.stat(id, problem));
    tags.forEach(id => references.tag(id, problem));
    if (tags.length !== new Set(tags).size) problem('Remove duplicate tag assignments before exporting.');
    allowedMovementZones.forEach(id => references.zone(id, problem));
    // The board clamps defaults at placement, including saved values from before a range edit.
    const defaults = Object.fromEntries(statIds.filter(id => Object.hasOwn(tool.defaults, id) && known.stat.has(id))
      .map(id => {
        const {min, max} = known.stat.get(id);
        return [id, Math.max(min, Math.min(max, tool.defaults[id]))];
      }));

    return {
      ...unityFields(tool, ['id', 'name', 'description', 'kind', 'mobile']),
      tags,
      statIds,
      defaults,
      allowedMovementZones,
      rules: unityRules(tool, problem, references),
      ...unityGraph(tool, includeTrees, problem, references),
    };
  });

  if (issues.size) return {data: null, issues: [...issues]};
  return {
    data: {
      format: 'prototeer-unity',
      formatVersion: 1,
      name: world.name,
      stats: world.stats.filter(stat => required.stat.has(stat.id)).map(stat =>
        unityFields(stat, ['id', 'name', 'description', 'min', 'max', 'start'])),
      tagDefs: world.tagDefs.filter(tag => required.tag.has(tag.id)).map(tag =>
        unityFields(tag, ['id', 'name', 'description'])),
      tools,
      zones: world.zones.filter(zone => required.zone.has(zone.id)).map(zone =>
        unityFields(zone, ['id', 'name', 'description'])),
    },
    issues: [],
  };
}
