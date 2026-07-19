import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import {
  btwContentText,
  createBtwMarkdownRenderer,
  escapeBtwText,
  renderBtwEntryParts,
} from "./btw-render.js";

describe("btw render helpers", () => {
  it("escapes text and falls back when markdown parsing fails", () => {
    const dom = new JSDOM("<body></body>");
    expect(escapeBtwText("<x>", { documentImpl: dom.window.document })).toBe("&lt;x&gt;");
    const parse = vi.spyOn(marked, "parse").mockImplementation(() => expect.fail("bad markdown"));
    const toHtml = createBtwMarkdownRenderer({
      documentImpl: dom.window.document,
      markedImpl: marked,
    });
    expect(toHtml("<script>")).toBe("&lt;script&gt;");
    parse.mockRestore();
  });

  it("extracts text from string and structured content", () => {
    expect(btwContentText("hello")).toBe("hello");
    expect(
      btwContentText([
        { type: "text", text: "one " },
        { type: "toolCall", name: "run" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one two");
    expect(btwContentText(null)).toBe("");
  });

  it("renders user and assistant markdown parts", () => {
    const toHtml = vi.fn((text) => `<p>${text}</p>`);
    expect(
      renderBtwEntryParts(
        {
          id: "user",
          type: "message",
          message: { role: "user", content: " hi " },
        },
        { toHtml },
      ),
    ).toEqual({ role: "user", parts: [{ kind: "md", html: "<p>hi</p>" }] });

    expect(
      renderBtwEntryParts(
        {
          id: "assistant",
          type: "message",
          message: { role: "assistant", content: "answer" },
        },
        { toHtml },
      ),
    ).toEqual({ role: "assistant", parts: [{ kind: "md", html: "<p>answer</p>" }] });
  });

  it("renders assistant tool calls and bash commands as tool parts", () => {
    expect(
      renderBtwEntryParts(
        {
          id: "tool-call",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read_file", arguments: { path: "a.txt" } }],
          },
        },
        { formatToolCallImpl: (name, args) => `${name}:${String(args.path)}` },
      ),
    ).toEqual({
      role: "assistant",
      parts: [{ kind: "tool", text: "read_file:a.txt" }],
    });

    expect(
      renderBtwEntryParts({
        id: "bash",
        type: "message",
        message: { role: "bashExecution", command: "ls" },
      }),
    ).toEqual({
      role: "assistant",
      parts: [{ kind: "tool", text: "$ ls" }],
    });
  });

  it("skips empty or unsupported entries", () => {
    expect(renderBtwEntryParts(null)).toBe(null);
    expect(renderBtwEntryParts({ id: "tool", type: "tool" })).toBe(null);
    expect(
      renderBtwEntryParts({
        id: "empty-user",
        type: "message",
        message: { role: "user", content: " " },
      }),
    ).toBe(null);
    expect(
      renderBtwEntryParts({
        id: "empty-assistant",
        type: "message",
        message: { role: "assistant", content: [] },
      }),
    ).toBe(null);
  });
});
