import { afterEach, assert, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { t } from "../../../shared/strings.js";
import ChatSelectorPopups from "./ChatSelectorPopups.svelte";
const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  assert(el);
  return el;
};

afterEach(() => {
  cleanup();
});

describe("ChatSelectorPopups", () => {
  it("renders selector runtime anchors with stable ids and classes", () => {
    render(ChatSelectorPopups);

    expect(byId("pi-chat-model-popup").className).toBe("pi-chat-model-popup");
    expect(byId("pi-chat-model-popup").style.display).toBe("none");
    expect(byId("pi-chat-model-search").getAttribute("autocomplete")).toBe("off");
    expect(byId("pi-chat-model-search").getAttribute("placeholder")).toBe(
      t("composer.searchModels"),
    );
    expect(byId("pi-chat-model-list").className).toBe("pi-chat-model-list");

    expect(byId("pi-chat-thinking-popup").className).toBe("pi-chat-thinking-popup");
    expect(byId("pi-chat-thinking-list").className).toBe("pi-chat-thinking-list");
    expect(byId("pi-chat-slash-popup").className).toBe("pi-chat-slash-popup");
    expect(byId("pi-chat-slash-list").className).toBe("pi-chat-slash-list");
    expect(byId("pi-chat-mention-popup").className).toBe("pi-chat-slash-popup");
    expect(byId("pi-chat-mention-list").className).toBe("pi-chat-slash-list");
  });
});
