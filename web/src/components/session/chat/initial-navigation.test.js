import { describe, expect, it, vi } from 'vitest';
import { navigateInitialChatLeaf } from './initial-navigation.js';

describe('navigateInitialChatLeaf', () => {
  it('navigates to a target when the deep-link id exists', () => {
    const navigateTo = vi.fn();

    navigateInitialChatLeaf({
      leafId: 'leaf',
      urlTargetId: 'target',
      byId: new Map([['target', {}]]),
      navigateTo,
    });

    expect(navigateTo).toHaveBeenCalledWith('leaf', 'target', 'target');
  });

  it('navigates to the leaf without scrolling when the target is missing', () => {
    const navigateTo = vi.fn();

    navigateInitialChatLeaf({
      leafId: 'leaf',
      urlTargetId: 'missing',
      byId: new Map(),
      navigateTo,
    });

    expect(navigateTo).toHaveBeenCalledWith('leaf', 'none');
  });

  it('falls back to the last entry when no leaf id is known', () => {
    const navigateTo = vi.fn();

    navigateInitialChatLeaf({
      entries: [{ id: 'first' }, { id: 'last' }],
      navigateTo,
    });

    expect(navigateTo).toHaveBeenCalledWith('last', 'none');
  });

  it('does nothing for an empty session without a leaf id', () => {
    const navigateTo = vi.fn();

    navigateInitialChatLeaf({ navigateTo });

    expect(navigateTo).not.toHaveBeenCalled();
  });
});
