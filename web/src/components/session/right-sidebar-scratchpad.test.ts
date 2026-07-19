import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createScratchpadController } from "./right-sidebar-scratchpad.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderScratchpad(value = ""): {
  readonly textarea: HTMLTextAreaElement;
  readonly statusEl: HTMLElement;
} {
  document.body.innerHTML = `
    <textarea id="scratchpad-textarea"></textarea>
    <span id="scratchpad-status"></span>
  `;
  const textarea = document.querySelector<HTMLTextAreaElement>("#scratchpad-textarea");
  const statusEl = document.getElementById("scratchpad-status");
  assert(textarea);
  assert(statusEl);
  textarea.value = value;
  return { textarea, statusEl };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createScratchpadController", () => {
  it("loads scratchpad content and treats it as saved", async () => {
    const { textarea, statusEl } = renderScratchpad("initial");
    const fetchImpl = vi.fn().mockResolvedValue(response({ content: "server notes" }));
    const scratchpad = createScratchpadController({
      projectPath: "/proj a",
      textarea,
      statusEl,
      fetchImpl,
    });

    await scratchpad.load();
    await scratchpad.save();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/scratchpad?project=%2Fproj%20a",
      expect.objectContaining({ method: "GET" }),
    );
    expect(textarea.value).toBe("server notes");
    expect(statusEl.textContent).toBe("Saved");
    expect(statusEl.className).toBe("scratchpad-status saved");
  });

  it("posts changed content and updates the saved baseline", async () => {
    const { textarea, statusEl } = renderScratchpad("initial");
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const scratchpad = createScratchpadController({
      projectPath: "/proj",
      textarea,
      statusEl,
      fetchImpl,
    });

    scratchpad.adoptCurrentValue();
    textarea.value = "changed";
    await scratchpad.save();
    await scratchpad.save();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/scratchpad",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ project: "/proj", content: "changed" }),
      }),
    );
    expect(statusEl.textContent).toBe("Saved");
    expect(statusEl.className).toBe("scratchpad-status saved");
  });

  it("debounces input saves and cleanup removes the listener", async () => {
    const { textarea, statusEl } = renderScratchpad("initial");
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const clearTimeoutImpl = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const scratchpad = createScratchpadController({
      projectPath: "/proj",
      textarea,
      statusEl,
      fetchImpl,
      clearTimeoutImpl,
      saveDelayMs: 250,
    });

    scratchpad.adoptCurrentValue();
    const cleanup = scratchpad.bind();
    textarea.value = "queued";
    textarea.dispatchEvent(new Event("input"));

    expect(statusEl.textContent).toBe("Saving…");
    expect(statusEl.className).toBe("scratchpad-status saving");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    cleanup();
    textarea.value = "ignored";
    textarea.dispatchEvent(new Event("input"));
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutImpl).toHaveBeenCalledWith(expect.anything());
  });

  it("reports load and save failures", async () => {
    const { textarea, statusEl } = renderScratchpad("initial");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}, 500));
    const scratchpad = createScratchpadController({
      projectPath: "/proj",
      textarea,
      statusEl,
      fetchImpl,
    });

    await scratchpad.load();
    expect(statusEl.textContent).toBe("Load failed");
    expect(statusEl.className).toBe("scratchpad-status");

    textarea.value = "changed";
    await scratchpad.save();
    expect(statusEl.textContent).toBe("Save failed");
    expect(statusEl.className).toBe("scratchpad-status");
  });
});
