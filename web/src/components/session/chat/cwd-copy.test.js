import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { setupCwdCopy } from './cwd-copy.js';

function setupDom() {
  const dom = new JSDOM(
    '<body><form id="pi-chat-composer"></form><span class="pi-chat-cwd" data-cwd="/tmp/project">cwd: /tmp/project</span></body>',
  );
  return dom;
}

describe('cwd copy', () => {
  it('copies the cwd with the Clipboard API and shows a success toast', async () => {
    const dom = setupDom();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    setupCwdCopy({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      tImpl: (key) => key,
      setTimeoutImpl: vi.fn(),
      clearTimeoutImpl: vi.fn(),
    });
    dom.window.document.querySelector('.pi-chat-cwd').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith('/tmp/project');
    expect(dom.window.document.getElementById('pi-chat-cwd-toast').textContent).toBe(
      'composer.pathCopied',
    );
  });

  it('falls back to execCommand when the Clipboard API fails', async () => {
    const dom = setupDom();
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    dom.window.document.execCommand = vi.fn(() => true);

    setupCwdCopy({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      tImpl: (key) => key,
      setTimeoutImpl: vi.fn(),
      clearTimeoutImpl: vi.fn(),
    });
    dom.window.document.querySelector('.pi-chat-cwd').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.window.document.execCommand).toHaveBeenCalledWith('copy');
    expect(dom.window.document.getElementById('pi-chat-cwd-toast').textContent).toBe(
      'composer.pathCopied',
    );
  });

  it('shows an error toast when copy fails', async () => {
    const dom = setupDom();
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    dom.window.document.execCommand = vi.fn(() => false);

    setupCwdCopy({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      tImpl: (key) => key,
      setTimeoutImpl: vi.fn(),
      clearTimeoutImpl: vi.fn(),
    });
    dom.window.document.querySelector('.pi-chat-cwd').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toast = dom.window.document.getElementById('pi-chat-cwd-toast');
    expect(toast.textContent).toBe('common.copyFailed');
    expect(toast.style.background).toBe('var(--error)');
  });
});
