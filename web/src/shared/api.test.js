import { describe, expect, it, vi } from 'vitest';
import { getJSON, postJSON } from './api.js';

describe('api helpers', () => {
  it('returns parsed JSON for a successful GET', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(getJSON('/api/models', { fetchImpl })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('/api/models', {
      headers: { Accept: 'application/json' },
    });
  });

  it('throws the JSON error message for failed responses', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }),
    );
    await expect(getJSON('/api/bad', { fetchImpl })).rejects.toThrow('bad request');
  });

  it('rejects with HTTP status for failed non-JSON responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('Internal Server Error', { status: 500 }));
    await expect(getJSON('/api/fail', { fetchImpl })).rejects.toThrow('HTTP 500');
  });

  it('rejects with invalid json response for successful non-JSON responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    await expect(getJSON('/api/not-json', { fetchImpl })).rejects.toThrow('invalid json response');
  });

  it('propagates fetchImpl rejections', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network error');
    });
    await expect(getJSON('/api/network', { fetchImpl })).rejects.toThrow('network error');
  });

  it('POSTs JSON bodies with the expected headers', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(
      postJSON('/api/new-session', { path: '/tmp/project' }, { fetchImpl }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('/api/new-session', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/project' }),
    });
  });

  it('throws the JSON error message for failed POST responses', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'failed' }), { status: 500 }),
    );
    await expect(postJSON('/api/new-session', { path: '/nope' }, { fetchImpl })).rejects.toThrow(
      'failed',
    );
  });
});
