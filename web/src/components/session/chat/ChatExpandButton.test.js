import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import ChatExpandButton from './ChatExpandButton.svelte';

afterEach(() => {
  cleanup();
});

describe('ChatExpandButton', () => {
  it('renders the composer expansion runtime anchor', () => {
    render(ChatExpandButton, { props: { chatAvailable: true } });

    const button = document.getElementById('pi-chat-expand');
    expect(button.className).toBe('pi-chat-expand-button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Expand composer');
    expect(button.disabled).toBe(false);
    expect(button.querySelector('svg')).toBeTruthy();
  });

  it('disables the button when chat is unavailable', () => {
    render(ChatExpandButton, { props: { chatAvailable: false } });

    expect(document.getElementById('pi-chat-expand').disabled).toBe(true);
  });
});
