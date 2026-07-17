import { describe, expect, it } from 'vitest';
import { SessionDataModel } from './session-data.svelte.js';

// A small two-branch session: root → (old leaf) and root → mid → leaf.
const entries = [
  {
    id: 'root',
    timestamp: '2026-01-01T00:00:00Z',
    type: 'message',
    message: { role: 'user', content: 'start' },
  },
  {
    id: 'old',
    parentId: 'root',
    timestamp: '2026-01-01T00:01:00Z',
    type: 'message',
    message: { role: 'assistant', content: 'old branch' },
  },
  {
    id: 'mid',
    parentId: 'root',
    timestamp: '2026-01-01T00:02:00Z',
    type: 'message',
    message: { role: 'assistant', content: 'mid' },
  },
  {
    id: 'leaf',
    parentId: 'mid',
    timestamp: '2026-01-01T00:03:00Z',
    type: 'message',
    message: { role: 'user', content: 'tell me about widgets' },
  },
];

function model(extra = {}) {
  return new SessionDataModel({ entries, header: { cwd: '/x' }, leafId: 'leaf', ...extra });
}

describe('SessionDataModel', () => {
  it('hydrates raw data and view state from a plain payload', () => {
    const m = model();
    expect(m.entries).toHaveLength(4);
    expect(m.header.cwd).toBe('/x');
    expect(m.currentLeafId).toBe('leaf');
    expect(m.currentTargetId).toBe('leaf');
  });

  it('derives lookups (byId / toolCallMap / labelMap)', () => {
    const m = model();
    expect(m.byId.get('mid').parentId).toBe('root');
    expect([...m.byId.keys()]).toEqual(['root', 'old', 'mid', 'leaf']);
  });

  it('derives the tree from entries', () => {
    const m = model();
    expect(m.tree.map((n) => n.entry.id)).toEqual(['root']);
    expect(m.tree[0].children.map((n) => n.entry.id)).toEqual(['old', 'mid']);
  });

  it('derives the active path from the current leaf', () => {
    const m = model();
    expect([...m.activePathIds].sort()).toEqual(['leaf', 'mid', 'root']);
    // 'old' is on the other branch, so it is not on the active path.
    expect(m.activePathIds.has('old')).toBe(false);
  });

  it('recomputes the active path when navigating', () => {
    const m = model();
    m.navigateTo('old');
    expect(m.currentLeafId).toBe('old');
    expect([...m.activePathIds].sort()).toEqual(['old', 'root']);
    expect(m.activePathIds.has('leaf')).toBe(false);
  });

  it('reactively recomputes derived state when entries change (live update)', () => {
    const m = model();
    expect(m.byId.has('leaf2')).toBe(false);

    m.applyLiveUpdate({
      entries: [
        ...entries,
        {
          id: 'leaf2',
          parentId: 'leaf',
          timestamp: '2026-01-01T00:04:00Z',
          type: 'message',
          message: { role: 'assistant', content: 'widgets are great' },
        },
      ],
      header: { cwd: '/x' },
      leafId: 'leaf2',
    });

    expect(m.byId.has('leaf2')).toBe(true);
    expect(m.nodeMap.get('leaf').children.map((n) => n.entry.id)).toEqual(['leaf2']);
    // view state preserved across a live update (we were on 'leaf')
    expect(m.currentLeafId).toBe('leaf');
  });

  it('reconcile() merges new entries in place and advances the active leaf', () => {
    const m = model();
    m.navigateTo('leaf');
    m.reconcile([
      ...entries,
      {
        id: 'leaf2',
        parentId: 'leaf',
        timestamp: '2026-01-01T00:04:00Z',
        type: 'message',
        message: { role: 'assistant', content: 'more' },
      },
    ]);
    expect(m.byId.has('leaf2')).toBe(true);
    // active leaf follows to the newest descendant of where we were.
    expect(m.currentLeafId).toBe('leaf2');
    expect(m.leafId).toBe('leaf2');
  });

  it('reconcile() ignores non-array input', () => {
    const m = model();
    m.reconcile(undefined);
    expect(m.entries).toHaveLength(4);
  });

  it('reconcile() prepends earlier entries without moving the active leaf off-branch', () => {
    const m = model();
    m.navigateTo('old');
    m.reconcile(entries);
    // staying on 'old' (a leaf), the newest descendant is itself.
    expect(m.currentLeafId).toBe('old');
  });

  it('reconcile() advances off the session-header leaf when real entries arrive', () => {
    // A brand-new session's JSONL contains only the {type:'session'} header
    // line, so hydration parks currentLeafId on that id. When the user sends
    // the first message the real chain has its own parentId:null root, so the
    // session header has no children to walk to. Reconcile must still pick the
    // newest real entry as the active leaf or the content pane stays empty.
    const m = new SessionDataModel({
      entries: [{ type: 'session', id: 'sess-1', timestamp: '2026-01-01T00:00:00Z' }],
      header: { id: 'sess-1' },
      leafId: 'sess-1',
    });
    expect(m.currentLeafId).toBe('sess-1');
    m.reconcile([
      { type: 'session', id: 'sess-1', timestamp: '2026-01-01T00:00:00Z' },
      {
        type: 'model_change',
        id: 'mc',
        parentId: null,
        timestamp: '2026-01-01T00:00:01Z',
        provider: 'p',
        modelId: 'm',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: 'mc',
        timestamp: '2026-01-01T00:00:02Z',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-01-01T00:00:03Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    expect(m.currentLeafId).toBe('a1');
    expect(m.activePath.map((e) => e.id)).toEqual(['mc', 'u1', 'a1']);
  });

  it('derives the ordered active path (root→leaf)', () => {
    const m = model();
    expect(m.activePath.map((e) => e.id)).toEqual(['root', 'mid', 'leaf']);
    m.navigateTo('old');
    expect(m.activePath.map((e) => e.id)).toEqual(['root', 'old']);
  });

  it('applies the search filter reactively', () => {
    const m = model();
    const unfiltered = m.filteredNodes.length;
    m.searchQuery = 'widgets';
    const filtered = m.filteredNodes.map((f) => f.node.entry.id);
    expect(filtered).toContain('leaf'); // matches "tell me about widgets"
    expect(m.filteredNodes.length).toBeLessThan(unfiltered);
  });

  it('builds a reactive model from an embedded payload via fromPayload', () => {
    const m = SessionDataModel.fromPayload(
      { header: {}, entries, leafId: 'leaf' },
      new URLSearchParams('targetId=mid'),
    );
    expect(m.currentLeafId).toBe('leaf');
    expect(m.currentTargetId).toBe('mid');
  });
});
