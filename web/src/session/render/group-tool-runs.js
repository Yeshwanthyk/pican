const TOOL_RUN_GROUP_THRESHOLD = 1;
const MAX_BREAKDOWN_TOOLS = 4;
const INTERACTIVE_TOOL_NAMES = new Set([
  'ask_user',
  'ask_user_question',
  'pican_ask_user_question',
]);

function analyzeToolRunEntry(entry, completedCallIds) {
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
      if (INTERACTIVE_TOOL_NAMES.has(block.name) && !completedCallIds.has(block.id)) return null;
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

function collectCompletedCallIds(activePath) {
  return new Set(
    activePath
      .filter((entry) => entry?.type === 'message' && entry.message?.role === 'toolResult')
      .map((entry) => entry.message.toolCallId)
      .filter(Boolean),
  );
}

function toolRunStatus(entries, toolCallIds, completedCallIds) {
  const failed = entries.some((entry) => {
    if (entry?.type === 'custom_message' && entry.customType === 'subagent-result') {
      return entry.details?.status === 'error';
    }
    if (entry?.type !== 'message') return false;
    if (entry.message?.role === 'toolResult') return entry.message.isError === true;
    if (entry.message?.role === 'bashExecution') {
      return (
        entry.message.cancelled === true ||
        (entry.message.exitCode !== null &&
          entry.message.exitCode !== undefined &&
          entry.message.exitCode !== 0)
      );
    }
    return false;
  });

  if (failed) return 'error';
  return toolCallIds.some((id) => !completedCallIds.has(id)) ? 'pending' : 'success';
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
  const completedCallIds = collectCompletedCallIds(activePath);

  for (let index = 0; index < activePath.length; ) {
    if (analyzeToolRunEntry(activePath[index], completedCallIds) === null) {
      renderItems.push({ kind: 'entry', entry: activePath[index] });
      index += 1;
      continue;
    }

    const entries = [];
    const toolNames = [];
    const toolCallIds = [];
    while (index < activePath.length) {
      const entryToolNames = analyzeToolRunEntry(activePath[index], completedCallIds);
      if (entryToolNames === null) break;
      entries.push(activePath[index]);
      toolNames.push(...entryToolNames);
      if (activePath[index]?.type === 'message') {
        for (const block of activePath[index].message?.content || []) {
          if (block?.type === 'toolCall' && block.id) toolCallIds.push(block.id);
        }
      }
      index += 1;
    }

    if (toolNames.length > TOOL_RUN_GROUP_THRESHOLD) {
      renderItems.push({
        kind: 'group',
        entries,
        toolCount: toolNames.length,
        breakdown: buildToolBreakdown(toolNames),
        status: toolRunStatus(entries, toolCallIds, completedCallIds),
      });
    } else {
      renderItems.push(...entries.map((entry) => ({ kind: 'entry', entry })));
    }
  }

  return renderItems;
}
