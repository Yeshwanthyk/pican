const TOOL_RUN_GROUP_THRESHOLD = 4;
const MAX_BREAKDOWN_TOOLS = 4;

function analyzeToolRunEntry(entry) {
  if (entry?.type === 'custom_message' && entry.customType === 'subagent-result') {
    return [];
  }

  if (entry?.type !== 'message') return null;

  const message = entry.message;
  if (message?.role === 'toolResult' || message?.role === 'bashExecution') return [];
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null;

  const toolNames = [];
  let hasToolActivity = false;

  for (const block of message.content) {
    if (block?.type === 'toolCall') {
      hasToolActivity = true;
      toolNames.push(
        typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool',
      );
      continue;
    }
    if (block?.type === 'thinking') {
      hasToolActivity = true;
      continue;
    }
    if (block?.type === 'text' && !String(block.text ?? '').trim()) continue;
    return null;
  }

  return hasToolActivity ? toolNames : null;
}

function buildToolBreakdown(toolNames) {
  const counts = new Map();
  toolNames.forEach((name, index) => {
    const current = counts.get(name);
    if (current) current.count += 1;
    else counts.set(name, { name, count: 1, firstIndex: index });
  });

  const sorted = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.firstIndex - b.firstIndex,
  );
  return {
    tools: sorted.slice(0, MAX_BREAKDOWN_TOOLS).map(({ name, count }) => ({ name, count })),
    remaining: Math.max(0, sorted.length - MAX_BREAKDOWN_TOOLS),
  };
}

export function formatToolRunBreakdown(breakdown, moreLabel = '') {
  const parts = (breakdown?.tools || []).map(({ name, count }) => `${name} x${count}`);
  if (breakdown?.remaining > 0 && moreLabel) parts.push(moreLabel);
  return parts.join(', ');
}

export function groupToolRuns(activePath = []) {
  const renderItems = [];

  for (let index = 0; index < activePath.length; ) {
    if (analyzeToolRunEntry(activePath[index]) === null) {
      renderItems.push({ kind: 'entry', entry: activePath[index] });
      index += 1;
      continue;
    }

    const entries = [];
    const toolNames = [];
    while (index < activePath.length) {
      const entryToolNames = analyzeToolRunEntry(activePath[index]);
      if (entryToolNames === null) break;
      entries.push(activePath[index]);
      toolNames.push(...entryToolNames);
      index += 1;
    }

    if (toolNames.length > TOOL_RUN_GROUP_THRESHOLD) {
      renderItems.push({
        kind: 'group',
        entries,
        toolCount: toolNames.length,
        breakdown: buildToolBreakdown(toolNames),
      });
    } else {
      renderItems.push(...entries.map((entry) => ({ kind: 'entry', entry })));
    }
  }

  return renderItems;
}
