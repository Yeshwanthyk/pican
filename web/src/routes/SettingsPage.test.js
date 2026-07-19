import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SettingsPage from './SettingsPage.svelte';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/settings');
});
afterEach(cleanup);

function activeNav() {
  return document.querySelector('.settings-sidebar-item.active')?.getAttribute('data-settings-nav');
}

describe('SettingsPage tab persistence', () => {
  it('defaults to the appearance tab when no section is in the URL', async () => {
    render(SettingsPage);
    await tick();
    expect(activeNav()).toBe('appearance');
    expect(document.querySelector('[data-settings-nav="language"]')).toBeNull();
  });

  it('restores the active tab from the ?section= query param on mount', async () => {
    window.history.replaceState({}, '', '/settings?section=machines');
    render(SettingsPage);
    await tick();
    expect(activeNav()).toBe('machines');
  });

  it('falls back to the default tab for an unknown section param', async () => {
    window.history.replaceState({}, '', '/settings?section=bogus');
    render(SettingsPage);
    await tick();
    expect(activeNav()).toBe('appearance');
  });

  it('writes the selected tab to the URL so a refresh restores it', async () => {
    render(SettingsPage);
    await tick();

    await fireEvent.click(document.querySelector('[data-settings-nav="notifications"]'));
    await tick();

    expect(window.location.search).toBe('?section=notifications');
    expect(activeNav()).toBe('notifications');
  });

  it('updates the URL without adding history entries when switching tabs', async () => {
    render(SettingsPage);
    await tick();
    const lengthBefore = window.history.length;

    await fireEvent.click(document.querySelector('[data-settings-nav="notifications"]'));
    await tick();
    await fireEvent.click(document.querySelector('[data-settings-nav="machines"]'));
    await tick();

    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.search).toBe('?section=machines');
  });
});
