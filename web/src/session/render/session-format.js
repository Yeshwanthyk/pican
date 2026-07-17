export function shortenPath(p) {
  if (typeof p !== 'string') return '';
  if (p.startsWith('/Users/')) {
    const parts = p.split('/');
    if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
  }
  if (p.startsWith('/home/')) {
    const parts = p.split('/');
    if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
  }
  return p;
}

export function formatToolCall(name, args = {}) {
  switch (name) {
    case 'read': {
      const path = shortenPath(String(args.path || args.file_path || ''));
      const offset = args.offset;
      const limit = args.limit;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : '';
        display += `:${start}${end ? `-${end}` : ''}`;
      }
      return `[read: ${display}]`;
    }
    case 'write':
      return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`;
    case 'edit':
      return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`;
    case 'bash': {
      const rawCmd = String(args.command || '');
      const cmd = rawCmd
        .replace(/[\n\t]/g, ' ')
        .trim()
        .slice(0, 50);
      return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
    }
    case 'grep':
      return `[grep: /${args.pattern || ''}/ in ${shortenPath(String(args.path || '.'))}]`;
    case 'find':
      return `[find: ${args.pattern || ''} in ${shortenPath(String(args.path || '.'))}]`;
    case 'ls':
      return `[ls: ${shortenPath(String(args.path || '.'))}]`;
    default: {
      const json = JSON.stringify(args);
      const preview = json.slice(0, 40);
      return `[${name}: ${preview}${json.length > 40 ? '...' : ''}]`;
    }
  }
}

export function escapeHtml(text, { documentImpl = globalThis.document } = {}) {
  if (documentImpl?.createElement) {
    const div = documentImpl.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function truncate(s, maxLen = 100) {
  s = String(s ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

export function getTreeNodeDisplayHtml(
  entry,
  label,
  { extractContent, toolCallMap = new Map(), escapeHtmlImpl = escapeHtml } = {},
) {
  const normalize = (s) =>
    String(s ?? '')
      .replace(/[\n\t]/g, ' ')
      .trim();
  const getContent = extractContent || ((content) => (typeof content === 'string' ? content : ''));
  const labelHtml = label ? `<span class="tree-label">[${escapeHtmlImpl(label)}]</span> ` : '';

  switch (entry.type) {
    case 'message': {
      const msg = entry.message;
      if (msg.role === 'user') {
        const content = truncate(normalize(getContent(msg.content)));
        return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtmlImpl(content)}`;
      }
      if (msg.role === 'assistant') {
        const textContent = truncate(normalize(getContent(msg.content)));
        if (textContent)
          return (
            labelHtml +
            `<span class="tree-role-assistant">assistant:</span> ${escapeHtmlImpl(textContent)}`
          );
        if (msg.stopReason === 'aborted')
          return (
            labelHtml +
            `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`
          );
        if (msg.errorMessage)
          return (
            labelHtml +
            `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtmlImpl(truncate(msg.errorMessage))}</span>`
          );
        return (
          labelHtml +
          `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`
        );
      }
      if (msg.role === 'toolResult') {
        const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
        if (toolCall)
          return (
            labelHtml +
            `<span class="tree-role-tool">${escapeHtmlImpl(formatToolCall(toolCall.name, toolCall.arguments))}</span>`
          );
        return labelHtml + `<span class="tree-role-tool">[${msg.toolName || 'tool'}]</span>`;
      }
      if (msg.role === 'bashExecution') {
        const cmd = truncate(normalize(msg.command || ''));
        return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtmlImpl(cmd)}`;
      }
      return labelHtml + `<span class="tree-muted">[${msg.role}]</span>`;
    }
    case 'compaction':
      return (
        labelHtml +
        `<span class="tree-compaction">[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]</span>`
      );
    case 'branch_summary': {
      const summary = truncate(normalize(entry.summary || ''));
      return (
        labelHtml +
        `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtmlImpl(summary)}`
      );
    }
    case 'custom_message': {
      const content = typeof entry.content === 'string' ? entry.content : getContent(entry.content);
      return (
        labelHtml +
        `<span class="tree-custom">[${escapeHtmlImpl(entry.customType)}]:</span> ${escapeHtmlImpl(truncate(normalize(content)))}`
      );
    }
    case 'model_change':
      return labelHtml + `<span class="tree-muted">[model: ${entry.modelId}]</span>`;
    case 'thinking_level_change':
      return labelHtml + `<span class="tree-muted">[thinking: ${entry.thinkingLevel}]</span>`;
    default:
      return labelHtml + `<span class="tree-muted">[${entry.type}]</span>`;
  }
}
