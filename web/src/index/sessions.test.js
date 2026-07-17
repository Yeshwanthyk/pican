import { describe, expect, it } from 'vitest';
import {
  dateBucketFor,
  formatRelativeTime,
  groupSessionsByDate,
  groupSessionsByProject,
  normalizeSession,
  sessionModelLabel,
  sessionSearchText,
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
      chatAvailable: true,
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
    };
    expect(sessionModelLabel(session)).toBe('openai/gpt');
    expect(sessionSearchText(session)).toContain('Fix bug /repo openai/gpt uuid');
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
});
