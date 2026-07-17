import { describe, expect, it } from 'vitest';
import { getComposerStorage } from './composer-storage.js';

describe('getComposerStorage', () => {
  it('returns window localStorage when accessible', () => {
    const storage = { getItem: () => null };

    expect(getComposerStorage({ windowImpl: { localStorage: storage } })).toBe(storage);
  });

  it('returns null when localStorage access throws', () => {
    const windowImpl = {};
    Object.defineProperty(windowImpl, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });

    expect(getComposerStorage({ windowImpl })).toBe(null);
  });
});
