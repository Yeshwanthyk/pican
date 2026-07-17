import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chatSessionId, createChatSelectorLoaders } from './selector-loaders.js';

function setupDom(url = 'http://localhost/session?id=url-session') {
  return new JSDOM(
    '<body><form id="pi-chat-composer" data-session-id="form-session"></form></body>',
    { url },
  );
}

describe('chat selector loaders', () => {
  it('resolves session id from URL before form data', () => {
    const dom = setupDom('http://localhost/session?id=url-session');
    expect(
      chatSessionId({
        documentImpl: dom.window.document,
        locationImpl: dom.window.location,
        URLSearchParamsImpl: dom.window.URLSearchParams,
      }),
    ).toBe('url-session');
  });

  it('falls back to composer dataset for session id', () => {
    const dom = setupDom('http://localhost/session');
    expect(
      chatSessionId({
        documentImpl: dom.window.document,
        locationImpl: dom.window.location,
        URLSearchParamsImpl: dom.window.URLSearchParams,
      }),
    ).toBe('form-session');
  });

  it('passes explicit dependencies to selector setup functions', () => {
    const dom = setupDom();
    const entries = [{ id: 'e1' }];
    const chatApi = {};
    const escapeHtml = vi.fn((text) => text);
    const setModelLabel = vi.fn();
    const setChatStatus = vi.fn();
    const setThinkingLabel = vi.fn();
    const setKnownModelLabel = vi.fn();
    const getKnownModelLabel = vi.fn(() => 'known model');
    const setCurrentModelForThinking = vi.fn();
    const setWorkerModelUpdate = vi.fn();
    const currentModel = { provider: 'openai', id: 'gpt-4o' };
    const getKnownThinkingLevel = vi.fn(() => 'high');
    const setKnownThinkingLevel = vi.fn();

    const modelApi = { open: vi.fn() };
    const thinkingApi = { cycle: vi.fn() };
    const slashApi = { handleKeydown: vi.fn() };
    const mentionApi = { handleKeydown: vi.fn() };
    const setupModelSelector = vi.fn(() => modelApi);
    const setupThinkingLevelSelector = vi.fn(() => thinkingApi);
    const setupSlashCommands = vi.fn(() => slashApi);
    const setupMentionAutocomplete = vi.fn(() => mentionApi);

    const loaders = createChatSelectorLoaders({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      locationImpl: dom.window.location,
      URLSearchParamsImpl: dom.window.URLSearchParams,
      entries,
      chatApi,
      escapeHtml,
      modelSelector: { setupModelSelector },
      thinkingSelector: { setupThinkingLevelSelector },
      slashSelector: { setupSlashCommands },
      mentionSelector: { setupMentionAutocomplete },
      setModelLabel,
      setChatStatus,
      setThinkingLabel,
      setKnownModelLabel,
      getKnownModelLabel,
      setCurrentModelForThinking,
      setWorkerModelUpdate,
      getCurrentModelForThinking: () => currentModel,
      getKnownThinkingLevel,
      setKnownThinkingLevel,
    });

    expect(loaders.loadModelSelector()).toBe(modelApi);
    expect(setupModelSelector.mock.calls[0][0]).toMatchObject({
      documentImpl: dom.window.document,
      sessionId: 'url-session',
      entries,
      chatApi,
      escapeHtml,
      setModelLabel,
      setChatStatus,
      setKnownModelLabel,
      getKnownModelLabel,
      setCurrentModelForThinking,
      setWorkerModelUpdate,
    });

    expect(loaders.loadThinkingSelector()).toBe(thinkingApi);
    const thinkingOpts = setupThinkingLevelSelector.mock.calls[0][0];
    expect(thinkingOpts).toMatchObject({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      sessionId: 'url-session',
      entries,
      chatApi,
      setThinkingLabel,
      setChatStatus,
      getKnownThinkingLevel,
      setKnownThinkingLevel,
    });
    expect(thinkingOpts.getCurrentModel()).toBe(currentModel);

    expect(loaders.loadSlashSelector()).toBe(slashApi);
    expect(setupSlashCommands.mock.calls[0][0]).toMatchObject({
      documentImpl: dom.window.document,
      sessionId: 'url-session',
      chatApi,
      escapeHtml,
    });

    expect(loaders.loadMentionSelector()).toBe(mentionApi);
    expect(setupMentionAutocomplete.mock.calls[0][0]).toMatchObject({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      sessionId: 'url-session',
      chatApi,
      escapeHtml,
    });
  });

  it('returns noop key handlers when optional selector APIs are absent', () => {
    const dom = setupDom();
    const loaders = createChatSelectorLoaders({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      locationImpl: dom.window.location,
      URLSearchParamsImpl: dom.window.URLSearchParams,
      modelSelector: { setupModelSelector: vi.fn() },
      thinkingSelector: { setupThinkingLevelSelector: vi.fn() },
      slashSelector: null,
      mentionSelector: {},
    });

    expect(loaders.loadSlashSelector().handleKeydown()).toBe(false);
    expect(loaders.loadMentionSelector().handleKeydown()).toBe(false);
  });
});
