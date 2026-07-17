import { afterEach, describe, expect, it } from 'vitest';
import { setupTextAttachmentViewer } from './text-attachment-viewer.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function renderModal() {
  document.body.innerHTML = `
    <div id="pi-chat-attachment-modal" hidden>
      <button type="button" data-action="close-attachment"></button>
      <pre class="pi-chat-attachment-card-quote"></pre>
      <div class="pi-chat-attachment-card-note" hidden></div>
    </div>
  `;
}

describe('setupTextAttachmentViewer', () => {
  it('opens the modal with quote and note content', () => {
    renderModal();
    const viewer = setupTextAttachmentViewer({ documentImpl: document });

    viewer.open({ original: 'hello world', note: 'rename this' });

    const modal = document.getElementById('pi-chat-attachment-modal');
    expect(modal.hidden).toBe(false);
    expect(document.querySelector('.pi-chat-attachment-card-quote').textContent).toBe(
      'hello world',
    );
    expect(document.querySelector('.pi-chat-attachment-card-note').textContent).toBe('rename this');
    expect(document.querySelector('.pi-chat-attachment-card-note').hidden).toBe(false);
  });

  it('hides the note when no note is present', () => {
    renderModal();
    const viewer = setupTextAttachmentViewer({ documentImpl: document });

    viewer.open({ original: 'hello world', note: '' });

    expect(document.querySelector('.pi-chat-attachment-card-note').hidden).toBe(true);
  });

  it('closes from the close action and Escape', () => {
    renderModal();
    const viewer = setupTextAttachmentViewer({ documentImpl: document });
    const modal = document.getElementById('pi-chat-attachment-modal');

    viewer.open({ original: 'hello' });
    document.querySelector('[data-action="close-attachment"]').click();
    expect(modal.hidden).toBe(true);

    viewer.open({ original: 'hello' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.hidden).toBe(true);
  });
});
