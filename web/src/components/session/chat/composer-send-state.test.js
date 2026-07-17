import { afterEach, describe, expect, it } from 'vitest';
import { createComposerSendState } from './composer-send-state.js';

function renderComposer(value = '') {
  document.body.innerHTML = `
    <textarea id="pi-chat-message"></textarea>
    <button id="pi-chat-send"></button>
  `;
  const textarea = document.getElementById('pi-chat-message');
  const sendButton = document.getElementById('pi-chat-send');
  textarea.value = value;
  return { textarea, sendButton };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createComposerSendState', () => {
  it('enables send for non-blank text', () => {
    const { textarea, sendButton } = renderComposer(' hello ');
    const state = createComposerSendState({ textarea, sendButton });

    state.updateSendEnabled();

    expect(state.hasComposerContent()).toBe(true);
    expect(sendButton.disabled).toBe(false);
  });

  it('enables send for attachments even when text is blank', () => {
    const { textarea, sendButton } = renderComposer('  ');
    const state = createComposerSendState({
      textarea,
      sendButton,
      getAttachments: () => ({ hasAttachments: () => true }),
    });

    state.updateSendEnabled();

    expect(state.hasComposerContent()).toBe(true);
    expect(sendButton.disabled).toBe(false);
  });

  it('disables send when there is no text or attachment', () => {
    const { textarea, sendButton } = renderComposer('  ');
    const state = createComposerSendState({ textarea, sendButton });

    state.updateSendEnabled();

    expect(state.hasComposerContent()).toBe(false);
    expect(sendButton.disabled).toBe(true);
  });

  it('does not override transient sending state', () => {
    const { textarea, sendButton } = renderComposer('hello');
    sendButton.dataset.sending = '1';
    sendButton.disabled = true;
    const state = createComposerSendState({ textarea, sendButton });

    state.updateSendEnabled();

    expect(sendButton.disabled).toBe(true);
  });
});
