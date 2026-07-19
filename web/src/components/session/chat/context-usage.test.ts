import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  buildContextWindows,
  collectContextUsage,
  createContextUsageController,
  getModelContextLimit,
  updateContextUsage,
} from "./context-usage.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function renderDom() {
  document.body.innerHTML = `
    <div id="pi-chat-context-usage" style="display:none">
      <svg><path class="pi-context-fill" stroke-dasharray="0, 100"></path></svg>
      <span class="pi-context-text">0%</span>
    </div>
    <div id="pi-chat-context-popover" style="display:none">
      <span class="pi-popover-used"></span>
      <span class="pi-popover-limit"></span>
      <div class="pi-popover-progress-bar"></div>
      <span id="pi-popover-val-input"></span>
      <span id="pi-popover-val-cache-read"></span>
      <span id="pi-popover-val-cache-write"></span>
      <span id="pi-popover-val-output"></span>
      <span id="pi-popover-val-total"></span>
    </div>
  `;
}

function query(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  assert(element);
  return element;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("context usage helpers", () => {
  it("builds model/provider context-window lookups", () => {
    const windows = buildContextWindows([
      { id: "DEEPSEEK-V4-PRO", provider: "DEEPSEEK", contextWindow: 1234567 },
    ]);
    expect(windows["deepseek-v4-pro"]).toBe(1234567);
    expect(windows["deepseek/deepseek-v4-pro"]).toBe(1234567);
    expect(getModelContextLimit("DEEPSEEK-V4-PRO", "DEEPSEEK", windows)).toBe(1234567);
  });

  it("uses fallback model limits", () => {
    expect(getModelContextLimit("gemini-1.5-flash")).toBe(1000000);
    expect(getModelContextLimit("claude-sonnet-4")).toBe(200000);
    expect(getModelContextLimit("llama-2-7b")).toBe(4096);
    expect(getModelContextLimit("unknown-model")).toBe(128000);
  });

  it("collects cumulative I/O but uses the last assistant for context pressure", () => {
    const usage = collectContextUsage([
      {
        id: "assistant-1",
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 1000 },
        },
      },
      { id: "user", type: "message", message: { role: "user", content: "follow-up" } },
      {
        id: "assistant-2",
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 500, output: 300, cacheRead: 1000, cacheWrite: 0 },
        },
      },
    ]);

    expect(usage.inputTokens).toBe(1500);
    expect(usage.outputTokens).toBe(800);
    expect(usage.cacheReadTokens).toBe(1000);
    expect(usage.cacheWriteTokens).toBe(1000);
    expect(usage.totalIOTokens).toBe(4300);
    expect(usage.contextTokens).toBe(1800);
  });
});

describe("updateContextUsage", () => {
  it("updates the capsule and popover values", () => {
    renderDom();

    updateContextUsage({
      documentImpl: document,
      knownModelLabel: "gpt-4o @ openai",
      entries: [
        {
          id: "assistant-1",
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 1000 },
          },
        },
        {
          id: "assistant-2",
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 500, output: 300, cacheRead: 1000, cacheWrite: 0 },
          },
        },
      ],
    });

    const el = query("#pi-chat-context-usage");
    expect(el.style.display).toBe("inline-flex");
    expect(query(".pi-context-text").textContent).toBe("1%");
    expect(query(".pi-context-fill").getAttribute("stroke-dasharray")).toBe("1, 100");
    expect(query("#pi-popover-val-total").textContent).toBe("4.3k");
    expect(query(".pi-popover-used").textContent).toBe("1.8k");
    expect(query(".pi-popover-limit").textContent).toBe("128k");
  });

  it("repositions the popover when visible", () => {
    renderDom();
    query("#pi-chat-context-popover").style.display = "block";
    const positionPopover = vi.fn();

    updateContextUsage({
      documentImpl: document,
      entries: [
        {
          id: "assistant",
          type: "message",
          message: { role: "assistant", usage: { totalTokens: 90000 } },
        },
      ],
      positionPopover,
    });

    expect(positionPopover).toHaveBeenCalledTimes(1);
  });

  it("loads dynamic limits from the session-scoped model list", async () => {
    renderDom();
    const listModels = vi.fn(() =>
      Promise.resolve(
        response({
          models: [{ id: "DEEPSEEK-V4-PRO", provider: "DEEPSEEK", contextWindow: 1234567 }],
        }),
      ),
    );
    const controller = createContextUsageController({
      documentImpl: document,
      entries: [
        {
          id: "assistant",
          type: "message",
          message: { role: "assistant", usage: { input: 1000, output: 500 } },
        },
      ],
      sessionId: "session.jsonl",
      getKnownModelLabel: () => "DEEPSEEK-V4-PRO @ DEEPSEEK",
      chatApi: { listModels },
    });

    controller.update();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listModels).toHaveBeenCalledWith("session.jsonl");
    expect(query(".pi-popover-limit").textContent).toBe("1.2M");
  });
});
