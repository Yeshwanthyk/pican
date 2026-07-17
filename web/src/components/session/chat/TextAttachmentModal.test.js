import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import TextAttachmentModal from './TextAttachmentModal.svelte';

afterEach(cleanup);

describe('TextAttachmentModal', () => {
  it('renders the IDs and hooks used by the chat composer runtime', () => {
    render(TextAttachmentModal);

    const modal = document.getElementById('pi-chat-attachment-modal');
    expect(modal).toBeTruthy();
    expect(modal.hidden).toBe(true);
    expect(modal.querySelector('[data-action="close-attachment"]')).toBeTruthy();
    expect(modal.querySelector('.pi-chat-attachment-card-quote')).toBeTruthy();
    expect(modal.querySelector('.pi-chat-attachment-card-note')?.hidden).toBe(true);
  });
});
