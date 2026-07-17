import { afterEach, describe, expect, it } from 'vitest';
import { getComposerElements } from './composer-elements.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('getComposerElements', () => {
  it('returns the composer runtime elements by stable id', () => {
    document.body.innerHTML = `
      <form id="pi-chat-composer">
        <div class="pi-chat-shell">
          <textarea id="pi-chat-message"></textarea>
          <input id="pi-chat-images">
          <button id="pi-chat-attach"></button>
          <div id="pi-chat-attachments"></div>
          <button id="pi-chat-send"></button>
          <button id="pi-chat-cancel"></button>
          <button id="pi-chat-expand"></button>
        </div>
      </form>
    `;
    const form = document.getElementById('pi-chat-composer');

    const elements = getComposerElements({ documentImpl: document, form });

    expect(elements.form).toBe(form);
    expect(elements.textarea.id).toBe('pi-chat-message');
    expect(elements.fileInput.id).toBe('pi-chat-images');
    expect(elements.attachButton.id).toBe('pi-chat-attach');
    expect(elements.attachmentList.id).toBe('pi-chat-attachments');
    expect(elements.sendButton.id).toBe('pi-chat-send');
    expect(elements.cancelButton.id).toBe('pi-chat-cancel');
    expect(elements.shell.className).toBe('pi-chat-shell');
    expect(elements.expandButton.id).toBe('pi-chat-expand');
  });

  it('returns null for missing optional anchors', () => {
    document.body.innerHTML = '<form id="pi-chat-composer"></form>';
    const form = document.getElementById('pi-chat-composer');

    const elements = getComposerElements({ documentImpl: document, form });

    expect(elements.textarea).toBe(null);
    expect(elements.shell).toBe(null);
    expect(elements.expandButton).toBe(null);
  });
});
