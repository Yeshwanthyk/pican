import { afterEach, describe, expect, it, vi } from 'vitest';
import { readComposerConfig } from './composer-config.js';

function renderForm(attrs = '') {
  document.body.innerHTML = `<form id="pi-chat-composer" ${attrs}></form>`;
  return document.getElementById('pi-chat-composer');
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readComposerConfig', () => {
  it('reports not ready when the form is missing', () => {
    const setChatStatus = vi.fn();

    expect(readComposerConfig({ form: null, setChatStatus })).toEqual({
      ready: false,
      sessionId: '',
      chatAvailable: false,
    });
    expect(setChatStatus).not.toHaveBeenCalled();
  });

  it('returns the session id when chat is available', () => {
    const form = renderForm('data-session-id="s1" data-chat-available="true"');
    const setChatStatus = vi.fn();

    expect(readComposerConfig({ form, setChatStatus })).toEqual({
      ready: true,
      sessionId: 's1',
      chatAvailable: true,
    });
    expect(setChatStatus).not.toHaveBeenCalled();
  });

  it('marks unavailable forms and copies the disabled reason to the title', () => {
    const form = renderForm(
      'data-session-id="s1" data-chat-available="false" data-chat-disabled-reason="no cwd"',
    );
    const setChatStatus = vi.fn();

    expect(readComposerConfig({ form, setChatStatus })).toEqual({
      ready: false,
      sessionId: 's1',
      chatAvailable: false,
    });
    expect(setChatStatus).toHaveBeenCalledWith('unavailable', 'error');
    expect(form.title).toBe('no cwd');
  });

  it('uses a default title when no disabled reason is present', () => {
    const form = renderForm('data-chat-available="false"');

    readComposerConfig({ form });

    expect(form.title).toBe('chat unavailable');
  });
});
