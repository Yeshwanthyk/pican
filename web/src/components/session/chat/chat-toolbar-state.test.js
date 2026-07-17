import { describe, expect, it, vi } from 'vitest';
import { ChatToolbarState, isRunningStatus } from './chat-toolbar-state.svelte.js';

describe('chat toolbar state', () => {
  it('detects statuses that should expose cancel', () => {
    expect(isRunningStatus('sending', '')).toBe(true);
    expect(isRunningStatus('idle', 'running')).toBe(true);
    expect(isRunningStatus('idle', '')).toBe(false);
  });

  it('tracks status text, class, and running state', () => {
    const toolbar = new ChatToolbarState();

    toolbar.setStatus('sending', 'running');
    expect(toolbar.statusText).toBe('sending');
    expect(toolbar.statusClass).toBe('running');
    expect(toolbar.isRunning).toBe(true);

    toolbar.setStatus('idle', '');
    expect(toolbar.statusText).toBe('idle');
    expect(toolbar.statusClass).toBe('');
    expect(toolbar.isRunning).toBe(false);
  });

  it('updates model label and refreshes context usage', () => {
    const toolbar = new ChatToolbarState();
    const updateContextUsage = vi.fn();
    toolbar.updateContextUsage = updateContextUsage;

    toolbar.setModelLabel('gpt-4o @ openai');
    expect(toolbar.modelLabel).toBe('gpt-4o @ openai');
    expect(updateContextUsage).toHaveBeenCalledTimes(1);

    // An empty label keeps the previous one (the template shows a placeholder).
    toolbar.setModelLabel('');
    expect(toolbar.modelLabel).toBe('gpt-4o @ openai');
    expect(updateContextUsage).toHaveBeenCalledTimes(2);
  });

  it('updates the thinking level', () => {
    const toolbar = new ChatToolbarState();

    toolbar.setThinkingLabel('high');
    expect(toolbar.thinkingLevel).toBe('high');

    toolbar.setThinkingLabel('');
    expect(toolbar.thinkingLevel).toBe('');
  });

  it('exposes known model and thinking getters/setters', () => {
    const toolbar = new ChatToolbarState();

    toolbar.setKnownModelLabel('claude @ anthropic');
    expect(toolbar.getKnownModelLabel()).toBe('claude @ anthropic');

    toolbar.setKnownThinkingLevel('medium');
    expect(toolbar.getKnownThinkingLevel()).toBe('medium');
  });
});
