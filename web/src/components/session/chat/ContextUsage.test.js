import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import ContextUsage from './ContextUsage.svelte';

afterEach(cleanup);

describe('ContextUsage', () => {
  it('renders the usage capsule IDs used by the composer runtime', () => {
    render(ContextUsage);

    expect(document.getElementById('pi-chat-context-usage')).toBeTruthy();
    expect(document.querySelector('#pi-chat-context-usage .pi-context-fill')).toBeTruthy();
    expect(document.querySelector('#pi-chat-context-usage .pi-context-text')?.textContent).toBe(
      '0%',
    );
  });

  it('renders the popover IDs used by the composer runtime', () => {
    render(ContextUsage, { props: { popover: true } });

    expect(document.getElementById('pi-chat-context-popover')).toBeTruthy();
    expect(document.getElementById('pi-popover-val-input')?.textContent).toBe('0');
    expect(document.getElementById('pi-popover-val-cache-read')?.textContent).toBe('0');
    expect(document.getElementById('pi-popover-val-cache-write')?.textContent).toBe('0');
    expect(document.getElementById('pi-popover-val-output')?.textContent).toBe('0');
    expect(document.getElementById('pi-popover-val-total')?.textContent).toBe('0');
  });
});
