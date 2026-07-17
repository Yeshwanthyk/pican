import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupComposerHeightVar } from './composer-height.js';

function makeForm(height = 42.2) {
  document.body.innerHTML = '<form id="pi-chat-composer"></form>';
  const form = document.getElementById('pi-chat-composer');
  vi.spyOn(form, 'getBoundingClientRect').mockReturnValue({ height });
  return form;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('setupComposerHeightVar', () => {
  it('sets the composer height CSS variable immediately', () => {
    setupComposerHeightVar({ documentImpl: document, windowImpl: window, form: makeForm(42.2) });

    expect(document.documentElement.style.getPropertyValue('--pi-chat-composer-height')).toBe(
      '43px',
    );
  });

  it('updates when the window resize listener fires', () => {
    const form = makeForm(10);
    let resizeHandler = null;
    const windowImpl = {
      ResizeObserver: null,
      addEventListener: vi.fn((eventName, handler, options) => {
        if (eventName === 'resize') resizeHandler = handler;
        expect(options).toEqual({ passive: true });
      }),
    };

    setupComposerHeightVar({ documentImpl: document, windowImpl, form });
    form.getBoundingClientRect.mockReturnValue({ height: 55.1 });
    resizeHandler();

    expect(document.documentElement.style.getPropertyValue('--pi-chat-composer-height')).toBe(
      '56px',
    );
  });

  it('observes the form when ResizeObserver is available', () => {
    const form = makeForm(12);
    const observe = vi.fn();
    const ResizeObserverImpl = vi.fn(function ResizeObserver(callback) {
      callback();
      return { observe };
    });

    setupComposerHeightVar({
      documentImpl: document,
      windowImpl: window,
      form,
      ResizeObserverImpl,
    });

    expect(ResizeObserverImpl).toHaveBeenCalledWith(expect.any(Function));
    expect(observe).toHaveBeenCalledWith(form);
  });
});
