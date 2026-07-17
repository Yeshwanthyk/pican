import { beforeEach, describe, expect, it } from 'vitest';
import { loadJSON, saveJSON } from './storage.js';

describe('storage helpers', () => {
  beforeEach(() => localStorage.clear());

  it('loads fallback when key is missing', () => {
    expect(loadJSON('missing', { collapsed: true })).toEqual({ collapsed: true });
  });

  it('saves and loads JSON values', () => {
    saveJSON('state', { a: 1 });
    expect(loadJSON('state', {})).toEqual({ a: 1 });
  });

  it('returns fallback when stored JSON is invalid', () => {
    localStorage.setItem('bad', '{');
    expect(loadJSON('bad', [])).toEqual([]);
  });

  it('does not throw when saveJSON fails', () => {
    const circular = {};
    circular.self = circular;
    expect(() => saveJSON('bad', circular)).not.toThrow();
  });
});
