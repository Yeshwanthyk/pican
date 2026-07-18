import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SessionCard from './SessionCard.svelte';

function session(overrides = {}) {
  return {
    id: 'session.jsonl',
    name: 'Session',
    project: '/repo',
    lastActivity: '2026-01-01T00:00:00Z',
    chatAvailable: true,
    model: 'model',
    modelProvider: 'provider',
    runtime: 'pi',
    ...overrides,
  };
}

describe('SessionCard runtime badge', () => {
  it('shows a semantic Codex badge and does not use the Pi mark', () => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime: 'codex', nativeId: 'thread-1' }) },
    });
    expect(screen.getByText('Codex')).toHaveAttribute('title', 'Codex runtime');
    expect(container.querySelector('.session-card-runtime-mark')).toHaveAttribute(
      'src',
      '/codex-icon.svg',
    );
    expect(container.querySelector('.session-card-mark')).not.toBeInTheDocument();
    expect(container.querySelector('.session-card').dataset.search).toContain('codex thread-1');
  });

  it('preserves the legacy Pi card treatment by default', () => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime: undefined }) },
    });
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();
    expect(container.querySelector('.session-card-mark')).toHaveAttribute('src', '/pi-icon.svg');
    expect(container.querySelector('.session-card').dataset.search).toContain('pi');
  });
});
