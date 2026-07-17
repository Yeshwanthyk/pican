import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showToast } from './toast.js';

function fakeElement() {
  const classes = new Set();
  return {
    id: '',
    className: '',
    textContent: '',
    title: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

function fakeDocument() {
  const byId = new Map();
  return {
    body: { appendChild: (el) => byId.set(el.id, el) },
    getElementById: (id) => byId.get(id) ?? null,
    createElement: () => fakeElement(),
  };
}

describe('showToast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates a toast element when missing and shows the message', () => {
    const documentImpl = fakeDocument();
    const notice = showToast('Renamed', { id: 'my-toast', documentImpl });

    expect(notice.id).toBe('my-toast');
    expect(notice.className).toBe('toast-notice');
    expect(notice.textContent).toBe('Renamed');
    expect(notice.classList.contains('visible')).toBe(true);
  });

  it('reuses an existing element by id', () => {
    const documentImpl = fakeDocument();
    const first = showToast('one', { id: 'dup', documentImpl });
    const second = showToast('two', { id: 'dup', documentImpl });

    expect(second).toBe(first);
    expect(first.textContent).toBe('two');
  });

  it('hides after the given duration and sets title when provided', () => {
    const documentImpl = fakeDocument();
    const notice = showToast('Copied', { id: 'copy', duration: 1200, title: 'cmd', documentImpl });

    expect(notice.title).toBe('cmd');
    expect(notice.classList.contains('visible')).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(notice.classList.contains('visible')).toBe(false);
  });
});
