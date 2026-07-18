import { describe, expect, it, vi } from 'vitest';
import {
  dateBucketFor,
  defaultCreateSession,
  formatRelativeTime,
  formatSessionMetrics,
  groupSessionsByDate,
  groupSessionsByProject,
  normalizeRuntimesResponse,
  normalizeSession,
  sessionModelLabel,
  sessionSearchText,
  splitPinnedSessions,
  shouldRefetchOnReload,
} from './sessions.js';

describe('index sessions helpers', () => {
  it('normalizes Go and JS-shaped sessions', () => {
    expect(
      normalizeSession({ ID: 'a', Project: '/repo', ModelProvider: 'p', Model: 'm' }),
    ).toMatchObject({
      id: 'a',
      project: '/repo',
      modelProvider: 'p',
      model: 'm',
      runtime: 'pi',
      nativeId: '',
      chatAvailable: true,
      pinned: false,
    });
    expect(normalizeSession({ id: 'a', pinned: true })).toMatchObject({ pinned: true });
    expect(normalizeSession({ ID: 'a', Pinned: true })).toMatchObject({ pinned: true });
    expect(normalizeSession({ ID: 'c', Runtime: 'CODEX', NativeID: 'thread-1' })).toMatchObject({
      runtime: 'codex',
      nativeId: 'thread-1',
    });
  });

  it('normalizes runtime responses and selects an available default', () => {
    expect(
      normalizeRuntimesResponse({
        defaultRuntime: 'codex',
        runtimes: [
          { id: 'pi', available: false, reason: 'pi missing' },
          { id: 'codex', available: true },
        ],
      }),
    ).toEqual({
      defaultRuntime: 'codex',
      selectedRuntime: 'codex',
      runtimes: [
        { id: 'pi', available: false, reason: 'pi missing' },
        { id: 'codex', available: true, reason: '' },
      ],
    });
    expect(normalizeRuntimesResponse()).toMatchObject({
      defaultRuntime: 'pi',
      selectedRuntime: 'pi',
      runtimes: [{ id: 'pi', available: true, reason: '' }],
    });
  });

  it('includes the selected runtime when creating a session', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 'new' })));
    await defaultCreateSession('/repo', 'codex', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('/api/new-session', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/repo', runtime: 'codex' }),
    });
  });

  it('formats relative times', () => {
    expect(formatRelativeTime('2024-01-01T00:00:00Z', Date.parse('2024-01-01T00:02:00Z'))).toBe(
      '2 minutes ago',
    );
    expect(formatRelativeTime('not a date')).toBe('');
  });

  it('builds labels and search text', () => {
    const session = {
      name: 'Fix bug',
      project: '/repo',
      modelProvider: 'openai',
      model: 'gpt',
      sessionUUID: 'uuid',
      runtime: 'codex',
      nativeId: 'thread-1',
    };
    expect(sessionModelLabel(session)).toBe('openai/gpt');
    expect(sessionSearchText(session)).toContain('Fix bug /repo openai/gpt uuid codex thread-1');
  });

  it('groups project layout by latest activity', () => {
    const groups = groupSessionsByProject([
      { id: 'old', project: 'a', lastActivity: '2024-01-01T00:00:00Z' },
      { id: 'new', project: 'b', lastActivity: '2024-01-03T00:00:00Z' },
      { id: 'mid', project: 'a', lastActivity: '2024-01-02T00:00:00Z' },
    ]);
    expect(groups.map((g) => g.project)).toEqual(['b', 'a']);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['mid', 'old']);
  });

  it('keeps one group per project even when sessions are interleaved in time', () => {
    const groups = groupSessionsByProject([
      { id: '1', project: 'a', lastActivity: '2024-01-03T00:00:00Z' },
      { id: '2', project: 'b', lastActivity: '2024-01-02T00:00:00Z' },
      { id: '3', project: 'a', lastActivity: '2024-01-01T00:00:00Z' },
    ]);
    expect(groups.map((g) => g.project)).toEqual(['a', 'b']);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['1', '3']);
  });

  it('buckets timestamps by recency relative to now', () => {
    const now = Date.parse('2024-03-15T12:00:00Z');
    const day = 86400000;
    expect(dateBucketFor(now, now)).toBe('today');
    expect(dateBucketFor(now - day, now)).toBe('yesterday');
    expect(dateBucketFor(now - 4 * day, now)).toBe('previous7days');
    expect(dateBucketFor(now - 20 * day, now)).toBe('previous30days');
    expect(dateBucketFor(now - 200 * day, now)).toBe('older');
    expect(dateBucketFor(Number.NEGATIVE_INFINITY, now)).toBe('older');
  });

  it('groups the timeline into ordered date buckets, newest first, across projects', () => {
    const now = Date.parse('2024-03-15T12:00:00Z');
    const day = 86400000;
    const groups = groupSessionsByDate(
      [
        { id: 'old', project: 'a', lastActivity: new Date(now - 100 * day).toISOString() },
        { id: 'today-a', project: 'a', lastActivity: new Date(now - 3600000).toISOString() },
        { id: 'today-b', project: 'b', lastActivity: new Date(now - 7200000).toISOString() },
        { id: 'yesterday', project: 'a', lastActivity: new Date(now - day).toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'older']);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['today-a', 'today-b']);
  });

  it('splits pinned sessions out, sorted by activity, and leaves the rest untouched', () => {
    const { pinned, rest } = splitPinnedSessions([
      { id: 'a', pinned: false, lastActivity: '2024-01-03T00:00:00Z' },
      { id: 'b', pinned: true, lastActivity: '2024-01-01T00:00:00Z' },
      { id: 'c', pinned: true, lastActivity: '2024-01-02T00:00:00Z' },
      { id: 'd', pinned: false, lastActivity: '2024-01-04T00:00:00Z' },
    ]);
    expect(pinned.map((s) => s.id)).toEqual(['c', 'b']);
    expect(rest.map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('returns empty pinned/rest for no sessions', () => {
    expect(splitPinnedSessions([])).toEqual({ pinned: [], rest: [] });
    expect(splitPinnedSessions()).toEqual({ pinned: [], rest: [] });
  });

  it('damps reload refetches for known sessions but not new ones', () => {
    const knownIds = new Set(['a', 'b']);
    const base = { knownIds, lastRefreshAt: 1000, throttleMs: 5000 };
    // Unknown or missing id → always refetch (new session must appear promptly).
    expect(shouldRefetchOnReload({ ...base, id: 'zz', now: 1001 })).toBe(true);
    expect(shouldRefetchOnReload({ ...base, id: '', now: 1001 })).toBe(true);
    // Known id inside the throttle window → skip.
    expect(shouldRefetchOnReload({ ...base, id: 'a', now: 5999 })).toBe(false);
    // Known id once the window elapses → refetch.
    expect(shouldRefetchOnReload({ ...base, id: 'a', now: 6000 })).toBe(true);
  });

  it('formats token/cost metrics with k/M abbreviation and hides zeros', () => {
    expect(formatSessionMetrics({ tokenTotal: 12345, costTotal: 0.42 })).toBe('12.3k tok · $0.42');
    expect(formatSessionMetrics({ tokenTotal: 1500000, costTotal: 2 })).toBe('1.5M tok · $2.00');
    expect(formatSessionMetrics({ tokenTotal: 500, costTotal: 0 })).toBe('500 tok');
    expect(formatSessionMetrics({ tokenTotal: 0, costTotal: 1.5 })).toBe('$1.50');
    expect(formatSessionMetrics({ tokenTotal: 0, costTotal: 0 })).toBe('');
    expect(formatSessionMetrics({})).toBe('');
  });
});
