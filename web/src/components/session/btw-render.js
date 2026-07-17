import { marked } from 'marked';
import { safeMarkedParse } from '../../session/render/markdown.js';
import { formatToolCall } from '../../session/render/session-format.js';

export function escapeBtwText(text, { documentImpl = document } = {}) {
  const node = documentImpl.createElement('div');
  node.textContent = String(text == null ? '' : text);
  return node.innerHTML;
}

export function createBtwMarkdownRenderer({ documentImpl = document, markedImpl = marked } = {}) {
  return (text) => {
    try {
      return safeMarkedParse(String(text == null ? '' : text), { marked: markedImpl });
    } catch {
      return escapeBtwText(text, { documentImpl });
    }
  };
}

export function btwContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('');
  }
  return '';
}

export function renderBtwEntryParts(
  entry,
  { toHtml = createBtwMarkdownRenderer(), formatToolCallImpl = formatToolCall } = {},
) {
  if (!entry || entry.type !== 'message' || !entry.message) return null;
  const msg = entry.message;
  if (msg.role === 'user') {
    const text = btwContentText(msg.content).trim();
    if (!text) return null;
    return { role: 'user', parts: [{ kind: 'md', html: toHtml(text) }] };
  }
  if (msg.role === 'assistant') {
    const parts = [];
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach((block) => {
      if (block.type === 'text' && block.text && block.text.trim()) {
        parts.push({ kind: 'md', html: toHtml(block.text) });
      } else if (block.type === 'toolCall') {
        parts.push({ kind: 'tool', text: formatToolCallImpl(block.name, block.arguments || {}) });
      }
    });
    if (parts.length === 0 && typeof msg.content === 'string' && msg.content.trim()) {
      parts.push({ kind: 'md', html: toHtml(msg.content) });
    }
    if (parts.length === 0) return null;
    return { role: 'assistant', parts };
  }
  if (msg.role === 'bashExecution' && msg.command) {
    return { role: 'assistant', parts: [{ kind: 'tool', text: `$ ${msg.command}` }] };
  }
  return null;
}
