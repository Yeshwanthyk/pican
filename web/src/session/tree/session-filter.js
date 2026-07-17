export function hasTextContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some((c) => c.type === 'text' && c.text && c.text.trim().length > 0);
  }
  return false;
}

export function extractContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('');
  }
  return '';
}

export function getSearchableText(entry, label) {
  const parts = [];
  if (label) parts.push(label);

  switch (entry.type) {
    case 'message': {
      const msg = entry.message;
      parts.push(msg.role);
      if (msg.content) parts.push(extractContent(msg.content));
      if (msg.role === 'bashExecution' && msg.command) parts.push(msg.command);
      break;
    }
    case 'custom_message':
      parts.push(entry.customType);
      parts.push(typeof entry.content === 'string' ? entry.content : extractContent(entry.content));
      break;
    case 'compaction':
      parts.push('compaction');
      break;
    case 'branch_summary':
      parts.push('branch summary', entry.summary);
      break;
    case 'model_change':
      parts.push('model', entry.modelId);
      break;
    case 'thinking_level_change':
      parts.push('thinking', entry.thinkingLevel);
      break;
  }

  return parts.join(' ').toLowerCase();
}

export function recalculateVisualStructure(filteredNodes, allFlatNodes) {
  if (filteredNodes.length === 0) return;

  const visibleIds = new Set(filteredNodes.map((n) => n.node.entry.id));
  const entryMap = new Map();
  for (const flatNode of allFlatNodes) entryMap.set(flatNode.node.entry.id, flatNode);

  function findVisibleAncestor(nodeId) {
    let currentId = entryMap.get(nodeId)?.node.entry.parentId;
    while (currentId != null) {
      if (visibleIds.has(currentId)) return currentId;
      currentId = entryMap.get(currentId)?.node.entry.parentId;
    }
    return null;
  }

  const visibleChildren = new Map([[null, []]]);
  for (const flatNode of filteredNodes) {
    const nodeId = flatNode.node.entry.id;
    const ancestorId = findVisibleAncestor(nodeId);
    if (!visibleChildren.has(ancestorId)) visibleChildren.set(ancestorId, []);
    const siblings = visibleChildren.get(ancestorId);
    if (!siblings.includes(nodeId)) siblings.push(nodeId);
  }

  const visibleRootIds = visibleChildren.get(null);
  const multipleRoots = visibleRootIds.length > 1;
  const filteredNodeMap = new Map(
    filteredNodes.map((flatNode) => [flatNode.node.entry.id, flatNode]),
  );
  const stack = [];

  for (let i = visibleRootIds.length - 1; i >= 0; i -= 1) {
    const isLast = i === visibleRootIds.length - 1;
    stack.push([
      visibleRootIds[i],
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      isLast,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop();
    const flatNode = filteredNodeMap.get(nodeId);
    if (!flatNode) continue;

    flatNode.indent = indent;
    flatNode.showConnector = showConnector;
    flatNode.isLast = isLast;
    flatNode.gutters = gutters;
    flatNode.isVirtualRootChild = isVirtualRootChild;
    flatNode.multipleRoots = multipleRoots;

    const children = visibleChildren.get(nodeId) || [];
    const multipleChildren = children.length > 1;
    let childIndent;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    for (let i = children.length - 1; i >= 0; i -= 1) {
      const childIsLast = i === children.length - 1;
      stack.push([
        children[i],
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }
}

export function filterNodes(
  flatNodes,
  currentLeafId,
  { filterMode = 'default', searchQuery = '' } = {},
) {
  const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

  const filtered = flatNodes.filter((flatNode) => {
    const entry = flatNode.node.entry;
    const label = flatNode.node.label;
    if (entry.id === currentLeafId) return true;

    if (entry.type === 'message' && entry.message.role === 'assistant') {
      const msg = entry.message;
      const hasText = hasTextContent(msg.content);
      const isErrorOrAborted =
        msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
      if (!hasText && !isErrorOrAborted) return false;
    }

    const isSettingsEntry = ['label', 'custom', 'model_change', 'thinking_level_change'].includes(
      entry.type,
    );
    let passesFilter;
    switch (filterMode) {
      case 'user-only':
        passesFilter = entry.type === 'message' && entry.message.role === 'user';
        break;
      case 'no-tools':
        passesFilter =
          !isSettingsEntry && !(entry.type === 'message' && entry.message.role === 'toolResult');
        break;
      case 'labeled-only':
        passesFilter = label !== undefined;
        break;
      case 'all':
        passesFilter = true;
        break;
      default:
        passesFilter = !isSettingsEntry;
        break;
    }
    if (!passesFilter) return false;

    if (searchTokens.length > 0) {
      const nodeText = getSearchableText(entry, label);
      if (!searchTokens.every((t) => nodeText.includes(t))) return false;
    }
    return true;
  });

  recalculateVisualStructure(filtered, flatNodes);
  return filtered;
}
