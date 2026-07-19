import { assert, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import * as chatApi from "../../../session/chat/chat-api.js";
import type { setupModelSelector as ModelSetup } from "./model-selector.js";
import type { setupThinkingLevelSelector as ThinkingSetup } from "./thinking-selector.js";
import type { setupSlashCommands as SlashSetup } from "./slash-command.js";
import type { setupMentionAutocomplete as MentionSetup } from "./mention-autocomplete.js";
import { chatSessionId, createChatSelectorLoaders } from "./selector-loaders.js";

function setupDom(url = "http://localhost/session?id=url-session") {
  return new JSDOM(
    '<body><form id="pi-chat-composer" data-session-id="form-session"></form></body>',
    { url },
  );
}

describe("chat selector loaders", () => {
  it("resolves session id from URL before form data", () => {
    const dom = setupDom("http://localhost/session?id=url-session");
    expect(
      chatSessionId({
        documentImpl: dom.window.document,
        locationImpl: dom.window.location,
        URLSearchParamsImpl: dom.window.URLSearchParams,
      }),
    ).toBe("url-session");
  });

  it("falls back to composer dataset for session id", () => {
    const dom = setupDom("http://localhost/session");
    expect(
      chatSessionId({
        documentImpl: dom.window.document,
        locationImpl: dom.window.location,
        URLSearchParamsImpl: dom.window.URLSearchParams,
      }),
    ).toBe("form-session");
  });

  it("passes explicit dependencies to selector setup functions", () => {
    const dom = setupDom();
    const entries = [{ id: "e1" }];
    const escapeHtml = vi.fn((text: string) => text);
    const setModelLabel = vi.fn();
    const setChatStatus = vi.fn();
    const setThinkingLabel = vi.fn();
    const setKnownModelLabel = vi.fn();
    const getKnownModelLabel = vi.fn(() => "known model");
    const setCurrentModelForThinking = vi.fn();
    const setWorkerModelUpdate = vi.fn();
    const currentModel = { provider: "openai", id: "gpt-4o" };
    const getKnownThinkingLevel = vi.fn(() => "high");
    const setKnownThinkingLevel = vi.fn();

    const modelApi = { open: vi.fn(), close: vi.fn() };
    const thinkingApi = { open: vi.fn(), close: vi.fn(), cycle: vi.fn() };
    const slashApi = { handleKeydown: vi.fn() };
    const mentionApi = { handleKeydown: vi.fn() };
    const setupModelSelectorMock = vi.fn((_options: Parameters<typeof ModelSetup>[0]) => modelApi);
    const setupThinkingLevelSelectorMock = vi.fn(
      (_options: Parameters<typeof ThinkingSetup>[0]) => thinkingApi,
    );
    const setupSlashCommandsMock = vi.fn((_options: Parameters<typeof SlashSetup>[0]) => slashApi);
    const setupMentionAutocompleteMock = vi.fn(
      (_options: Parameters<typeof MentionSetup>[0]) => mentionApi,
    );

    const loaders = createChatSelectorLoaders({
      documentImpl: dom.window.document,
      windowImpl: window,
      locationImpl: dom.window.location,
      URLSearchParamsImpl: dom.window.URLSearchParams,
      entries,
      chatApi,
      escapeHtml,
      modelSelector: { setupModelSelector: setupModelSelectorMock },
      thinkingSelector: { setupThinkingLevelSelector: setupThinkingLevelSelectorMock },
      slashSelector: { setupSlashCommands: setupSlashCommandsMock },
      mentionSelector: { setupMentionAutocomplete: setupMentionAutocompleteMock },
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
    const modelCall = setupModelSelectorMock.mock.calls[0];
    assert(modelCall);
    expect(modelCall[0]).toMatchObject({
      documentImpl: dom.window.document,
      sessionId: "url-session",
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
    const thinkingCall = setupThinkingLevelSelectorMock.mock.calls[0];
    assert(thinkingCall);
    const thinkingOpts = thinkingCall[0];
    assert(thinkingOpts);
    expect(thinkingOpts).toMatchObject({
      documentImpl: dom.window.document,
      windowImpl: window,
      sessionId: "url-session",
      entries,
      chatApi,
      setThinkingLabel,
      setChatStatus,
      getKnownThinkingLevel,
      setKnownThinkingLevel,
    });
    assert(thinkingOpts.getCurrentModel);
    expect(thinkingOpts.getCurrentModel()).toBe(currentModel);

    expect(loaders.loadSlashSelector()).toBe(slashApi);
    const slashCall = setupSlashCommandsMock.mock.calls[0];
    assert(slashCall);
    expect(slashCall[0]).toMatchObject({
      documentImpl: dom.window.document,
      sessionId: "url-session",
      chatApi,
      escapeHtml,
    });

    expect(loaders.loadMentionSelector()).toBe(mentionApi);
    const mentionCall = setupMentionAutocompleteMock.mock.calls[0];
    assert(mentionCall);
    expect(mentionCall[0]).toMatchObject({
      documentImpl: dom.window.document,
      windowImpl: window,
      sessionId: "url-session",
      chatApi,
      escapeHtml,
    });
  });

  it("returns noop key handlers when optional selector APIs are absent", () => {
    const dom = setupDom();
    const loaders = createChatSelectorLoaders({
      documentImpl: dom.window.document,
      windowImpl: window,
      locationImpl: dom.window.location,
      URLSearchParamsImpl: dom.window.URLSearchParams,
      modelSelector: { setupModelSelector: vi.fn() },
      thinkingSelector: { setupThinkingLevelSelector: vi.fn() },
      slashSelector: null,
      mentionSelector: {},
    });

    const event = new KeyboardEvent("keydown");
    expect(loaders.loadSlashSelector().handleKeydown(event)).toBe(false);
    expect(loaders.loadMentionSelector().handleKeydown(event)).toBe(false);
  });
});
