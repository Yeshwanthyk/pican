import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { setupAttachmentManager } from './attachment-manager.js';

function setupDom() {
  const dom = new JSDOM(
    '<body><textarea id="message"></textarea><input id="files"><button id="attach"></button><div id="attachments"></div><div id="pi-chat-attachment-modal" hidden><pre class="pi-chat-attachment-card-quote"></pre><div class="pi-chat-attachment-card-note" hidden></div><button type="button" data-action="close-attachment"></button></div></body>',
  );
  return {
    dom,
    textarea: dom.window.document.getElementById('message'),
    fileInput: dom.window.document.getElementById('files'),
    attachButton: dom.window.document.getElementById('attach'),
    attachmentList: dom.window.document.getElementById('attachments'),
  };
}

describe('attachment manager', () => {
  it('renders image previews from pasted files and deduplicates them', () => {
    const { dom, textarea, fileInput, attachButton, attachmentList } = setupDom();
    const updateSendEnabled = vi.fn();
    dom.window.URL.createObjectURL = vi.fn(() => 'blob:preview');
    setupAttachmentManager({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
      updateSendEnabled,
    });

    const file = new dom.window.File(['blob'], 'screenshot.png', { type: 'image/png' });
    const pasteEvent = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [file, file], items: [], getData: () => '' },
    });
    textarea.dispatchEvent(pasteEvent);

    expect(attachmentList.children.length).toBe(1);
    expect(attachmentList.firstElementChild.classList.contains('image-only')).toBe(true);
    expect(attachmentList.querySelector('.pi-chat-attachment-preview').getAttribute('src')).toBe(
      'blob:preview',
    );
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(updateSendEnabled).toHaveBeenCalled();
  });

  it('folds text attachments into composed messages', () => {
    const { dom, textarea, fileInput, attachButton, attachmentList } = setupDom();
    const manager = setupAttachmentManager({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
    });

    dom.window.dispatchEvent(
      new dom.window.CustomEvent('pi-chat-attach-text', {
        detail: { original: 'selected text', note: 'adjust wording' },
      }),
    );

    const chip = attachmentList.querySelector('.pi-chat-attachment-text');
    expect(chip).toBeTruthy();
    expect(manager.hasAttachments()).toBe(true);
    expect(manager.composeMessage('please update')).toBe(
      '> selected text\n\nadjust wording\n\nplease update',
    );

    chip.click();
    expect(dom.window.document.getElementById('pi-chat-attachment-modal').hidden).toBe(false);
    expect(dom.window.document.querySelector('.pi-chat-attachment-card-quote').textContent).toBe(
      'selected text',
    );
  });

  it('restores cleared attachment state', () => {
    const { dom, textarea, fileInput, attachButton, attachmentList } = setupDom();
    dom.window.URL.createObjectURL = vi.fn(() => 'blob:preview');
    dom.window.URL.revokeObjectURL = vi.fn();
    const manager = setupAttachmentManager({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
    });

    const file = new dom.window.File(['blob'], 'retry.png', { type: 'image/png' });
    manager.restore({
      files: [file],
      textAttachments: [{ original: 'quoted', note: '' }],
    });
    expect(attachmentList.children.length).toBe(2);

    const files = manager.files().slice();
    const textAttachments = manager.textAttachments().slice();
    manager.clear();
    expect(attachmentList.children.length).toBe(0);
    expect(dom.window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');

    manager.restore({ files, textAttachments });
    expect(attachmentList.children.length).toBe(2);
  });
});
