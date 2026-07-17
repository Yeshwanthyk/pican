import { describe, expect, it } from 'vitest';
import {
  buildActivePathIds,
  buildTree,
  buildTreePrefix,
  buildTreeNodeMap,
  findNewestLeaf,
  flattenTree,
  getPath,
  stitchOrphanRoots,
} from './session-tree.js';

const entries = [
  { id: 'root', timestamp: '2026-01-01T00:00:00Z' },
  { id: 'old', parentId: 'root', timestamp: '2026-01-01T00:01:00Z' },
  { id: 'new', parentId: 'root', timestamp: '2026-01-01T00:02:00Z' },
  { id: 'leaf', parentId: 'new', timestamp: '2026-01-01T00:03:00Z' },
  { id: 'orphan', parentId: 'missing', timestamp: '2026-01-01T00:04:00Z' },
];

function byId() {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

describe('session tree helpers', () => {
  it('builds roots, children, labels, and timestamp ordering', () => {
    const roots = buildTree(entries, new Map([['new', 'label']]));
    expect(roots.map((n) => n.entry.id)).toEqual(['root', 'orphan']);
    expect(roots[0].children.map((n) => n.entry.id)).toEqual(['old', 'new']);
    expect(roots[0].children[1].label).toBe('label');
  });

  it('ignores metadata entries without ids', () => {
    const roots = buildTree([...entries, { type: 'session_info', name: 'Renamed' }]);
    const flat = flattenTree(roots, buildActivePathIds('leaf', byId()));
    expect(flat.map((f) => f.node.entry.id)).toEqual(['root', 'new', 'leaf', 'old', 'orphan']);
  });

  it('deduplicates repeated ids before linking tree nodes', () => {
    const duplicated = [
      { id: 'session', timestamp: '2026-01-01T00:00:00Z', type: 'session' },
      {
        id: 'model',
        parentId: null,
        timestamp: '2026-01-01T00:01:00Z',
        type: 'model_change',
        modelId: 'old',
      },
      {
        id: 'thinking',
        parentId: 'model',
        timestamp: '2026-01-01T00:02:00Z',
        type: 'thinking_level_change',
        thinkingLevel: 'low',
      },
      {
        id: 'model',
        parentId: null,
        timestamp: '2026-01-01T00:03:00Z',
        type: 'model_change',
        modelId: 'new',
      },
      {
        id: 'thinking',
        parentId: 'model',
        timestamp: '2026-01-01T00:04:00Z',
        type: 'thinking_level_change',
        thinkingLevel: 'high',
      },
      {
        id: 'leaf',
        parentId: 'thinking',
        timestamp: '2026-01-01T00:05:00Z',
        type: 'message',
        message: { role: 'user', content: 'hi' },
      },
    ];

    const roots = buildTree(duplicated);
    const flat = flattenTree(
      roots,
      buildActivePathIds('leaf', new Map(duplicated.map((entry) => [entry.id, entry]))),
    );

    expect(flat.map((f) => f.node.entry.id)).toEqual(['model', 'thinking', 'leaf', 'session']);
    expect(roots.find((node) => node.entry.id === 'model').entry.modelId).toBe('new');
    expect(roots.find((node) => node.entry.id === 'model').children[0].entry.thinkingLevel).toBe(
      'high',
    );
  });

  it('builds active path and path entries from leaf to root', () => {
    expect([...buildActivePathIds('leaf', byId())]).toEqual(['leaf', 'new', 'root']);
    expect(getPath('leaf', byId()).map((e) => e.id)).toEqual(['root', 'new', 'leaf']);
  });

  it('finds newest reachable leaf', () => {
    const roots = buildTree(entries);
    expect(findNewestLeaf('root', buildTreeNodeMap(roots))).toBe('leaf');
    expect(findNewestLeaf('missing', roots)).toBe('missing');
  });

  it('does not treat label bookkeeping entries as newest navigable leaves', () => {
    const roots = buildTree([
      ...entries,
      {
        id: 'label-only',
        type: 'label',
        parentId: 'leaf',
        targetId: 'leaf',
        label: 'Done',
        timestamp: '2026-01-01T00:04:00Z',
      },
    ]);
    expect(findNewestLeaf('leaf', roots)).toBe('leaf');
  });

  it('flattens active branch first and builds prefixes', () => {
    const roots = buildTree(entries);
    const flat = flattenTree(roots, buildActivePathIds('leaf', byId()));
    expect(flat.map((f) => f.node.entry.id)).toEqual(['root', 'new', 'leaf', 'old', 'orphan']);
    expect(buildTreePrefix(flat[1])).toContain('├');
  });

  describe('stitchOrphanRoots', () => {
    it('links a resumed/forked second segment onto the prior segment leaf', () => {
      const forked = [
        { type: 'session', id: 'sess', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'model_change', id: 'mc-pre', parentId: null, timestamp: '2026-01-01T00:00:01Z' },
        { type: 'message', id: 'u-pre', parentId: 'mc-pre', timestamp: '2026-01-01T00:00:02Z' },
        { type: 'message', id: 'a-pre', parentId: 'u-pre', timestamp: '2026-01-01T00:00:03Z' },
        { type: 'model_change', id: 'mc-post', parentId: null, timestamp: '2026-01-01T00:00:04Z' },
        { type: 'message', id: 'u-post', parentId: 'mc-post', timestamp: '2026-01-01T00:00:05Z' },
        { type: 'message', id: 'a-post', parentId: 'u-post', timestamp: '2026-01-01T00:00:06Z' },
      ];
      const stitched = stitchOrphanRoots(forked);
      // The post-fork root is re-pointed onto the fork point (last pre-fork entry).
      expect(stitched.find((e) => e.id === 'mc-post').parentId).toBe('a-pre');
      // The pre-fork root and session header are untouched.
      expect(stitched.find((e) => e.id === 'mc-pre').parentId).toBe(null);
      expect(stitched.find((e) => e.id === 'sess').parentId).toBeUndefined();
      // getPath from the newest leaf now spans both segments.
      const map = new Map(stitched.map((e) => [e.id, e]));
      expect(getPath('a-post', map).map((e) => e.id)).toEqual([
        'mc-pre',
        'u-pre',
        'a-pre',
        'mc-post',
        'u-post',
        'a-post',
      ]);
    });

    it('returns the input unchanged for a single-segment session', () => {
      const single = [
        { type: 'session', id: 'sess', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'model_change', id: 'mc', parentId: null, timestamp: '2026-01-01T00:00:01Z' },
        { type: 'message', id: 'u', parentId: 'mc', timestamp: '2026-01-01T00:00:02Z' },
      ];
      expect(stitchOrphanRoots(single)).toBe(single);
    });
  });
});
