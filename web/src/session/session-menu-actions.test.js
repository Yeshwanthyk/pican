import { describe, expect, it, vi } from 'vitest';
import {
  cloneSession,
  forkSession,
  loadForkEntries,
  renameSession,
} from './session-menu-actions.js';

const jsonResponse = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

describe('session-menu-actions', () => {
  it('renameSession posts the new name and returns the payload', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ name: 'New' })));
    const data = await renameSession('s.jsonl', 'New', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/rename-session?id=s.jsonl',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'New' }) }),
    );
    expect(data).toEqual({ name: 'New' });
  });

  it('renameSession throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ error: 'bad' }, false)));
    await expect(renameSession('s.jsonl', 'New', { fetchImpl })).rejects.toThrow('bad');
  });

  it('loadForkEntries returns the entries array (empty when absent)', async () => {
    const withEntries = vi.fn(() => Promise.resolve(jsonResponse({ entries: [{ id: 'a' }] })));
    expect(await loadForkEntries('s.jsonl', { fetchImpl: withEntries })).toEqual([{ id: 'a' }]);

    const noEntries = vi.fn(() => Promise.resolve(jsonResponse({})));
    expect(await loadForkEntries('s.jsonl', { fetchImpl: noEntries })).toEqual([]);
  });

  it('forkSession posts the entry id', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ id: 'new.jsonl' })));
    const data = await forkSession('s.jsonl', 'e1', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/fork-session?id=s.jsonl',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ entryId: 'e1' }) }),
    );
    expect(data).toEqual({ id: 'new.jsonl' });
  });

  it('cloneSession posts to the clone endpoint', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ id: 'clone.jsonl' })));
    const data = await cloneSession('s.jsonl', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/clone-session?id=s.jsonl',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(data).toEqual({ id: 'clone.jsonl' });
  });
});
