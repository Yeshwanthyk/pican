import { describe, expect, it } from 'vitest';
import { buildActivePathIds, buildTree, flattenTree } from './session-tree.js';
import {
  extractContent,
  filterNodes,
  getSearchableText,
  hasTextContent,
} from './session-filter.js';

const entries = [
  {
    id: 'root',
    timestamp: '2026-01-01T00:00:00Z',
    type: 'message',
    message: { role: 'user', content: 'hello world' },
  },
  {
    id: 'assistant-tool-only',
    parentId: 'root',
    timestamp: '2026-01-01T00:01:00Z',
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1' }] },
  },
  {
    id: 'assistant-text',
    parentId: 'assistant-tool-only',
    timestamp: '2026-01-01T00:02:00Z',
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'answer text' }] },
  },
  {
    id: 'tool',
    parentId: 'assistant-text',
    timestamp: '2026-01-01T00:03:00Z',
    type: 'message',
    message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
  },
  {
    id: 'model',
    parentId: 'tool',
    timestamp: '2026-01-01T00:04:00Z',
    type: 'model_change',
    modelId: 'x',
  },
];

function flat(labelMap = new Map()) {
  const roots = buildTree(entries, labelMap);
  return flattenTree(roots, buildActivePathIds('model', new Map(entries.map((e) => [e.id, e]))));
}

describe('session filter helpers', () => {
  it('extracts text content and detects non-empty text', () => {
    expect(hasTextContent([{ type: 'toolCall' }])).toBe(false);
    expect(hasTextContent([{ type: 'text', text: ' hi ' }])).toBe(true);
    expect(
      extractContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    ).toBe('ab');
  });

  it('builds searchable text from labels and entries', () => {
    expect(getSearchableText(entries[0], 'Greeting')).toContain('greeting user hello world');
    expect(getSearchableText({ type: 'branch_summary', summary: 'summary text' })).toContain(
      'branch summary summary text',
    );
  });

  it('applies default filter and hides assistant tool-only messages', () => {
    expect(filterNodes(flat(), 'model').map((n) => n.node.entry.id)).toEqual([
      'root',
      'assistant-text',
      'tool',
      'model',
    ]);
  });

  it('applies no-tools, user-only, labeled-only, all, and search filters', () => {
    expect(
      filterNodes(flat(), 'none', { filterMode: 'no-tools' }).map((n) => n.node.entry.id),
    ).toEqual(['root', 'assistant-text']);
    expect(
      filterNodes(flat(), 'none', { filterMode: 'user-only' }).map((n) => n.node.entry.id),
    ).toEqual(['root']);
    expect(
      filterNodes(flat(new Map([['assistant-text', 'Keep']])), 'none', {
        filterMode: 'labeled-only',
      }).map((n) => n.node.entry.id),
    ).toEqual(['assistant-text']);
    expect(filterNodes(flat(), 'none', { filterMode: 'all' }).map((n) => n.node.entry.id)).toEqual([
      'root',
      'assistant-text',
      'tool',
      'model',
    ]);
    expect(
      filterNodes(flat(), 'none', { searchQuery: 'answer' }).map((n) => n.node.entry.id),
    ).toEqual(['assistant-text']);
  });

  it('recalculates visual structure when hidden ancestors are skipped', () => {
    const filtered = filterNodes(flat(), 'none', { searchQuery: 'tool output' });
    expect(filtered.map((n) => n.node.entry.id)).toEqual(['tool']);
    expect(filtered[0].indent).toBe(0);
    expect(filtered[0].multipleRoots).toBe(false);
  });
});
