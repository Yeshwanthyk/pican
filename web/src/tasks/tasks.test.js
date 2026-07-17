import { describe, expect, it } from 'vitest';
import {
  normalizeTask,
  normalizeTaskStore,
  shortSessionId,
  storesForSelection,
  taskCount,
  taskGroupsByStatus,
} from './tasks.js';

describe('tasks helpers', () => {
  it('normalizes task fields and unknown statuses', () => {
    expect(normalizeTask({ id: 4, status: 'unknown', blockedBy: [1, 'two'] })).toMatchObject({
      id: '4',
      status: 'pending',
      blockedBy: ['1', 'two'],
      execution: null,
    });
  });

  it('normalizes stores and filters the selected scope', () => {
    const stores = [
      normalizeTaskStore({ scope: 'project', tasks: [{ id: 1, status: 'pending' }] }),
      normalizeTaskStore({ scope: 'session', sessionId: 'session-1', tasks: [] }),
      normalizeTaskStore({ scope: 'global', tasks: [{ id: 2, status: 'completed' }] }),
    ];
    expect(storesForSelection(stores, '/repo')).toHaveLength(2);
    expect(storesForSelection(stores, 'global')).toHaveLength(1);
  });

  it('groups tasks by status without losing store boundaries', () => {
    const stores = [
      normalizeTaskStore({
        scope: 'project',
        tasks: [
          { id: 1, status: 'pending' },
          { id: 2, status: 'completed' },
        ],
      }),
      normalizeTaskStore({ scope: 'session', tasks: [{ id: 3, status: 'pending' }] }),
    ];
    const groups = taskGroupsByStatus(stores, 'pending');
    expect(groups.map((group) => group.tasks.map((task) => task.id))).toEqual([['1'], ['3']]);
    expect(taskCount(groups)).toBe(2);
  });

  it('shortens long session ids', () => {
    expect(shortSessionId('1234567890abcdef')).toBe('12345678…');
    expect(shortSessionId('short')).toBe('short');
  });
});
