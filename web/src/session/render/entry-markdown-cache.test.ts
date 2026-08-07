import { describe, expect, it, vi } from "vitest";
import { createEntryMarkdownCache } from "./entry-markdown-cache.js";

describe("entry Markdown cache", () => {
  it("caches multiple Markdown slots independently for one stable entry identity", () => {
    const parse = vi.fn((content: string) => `<p>${content}</p>`);
    const markdown = createEntryMarkdownCache(parse);
    const entry = { id: "entry-1" };

    expect(markdown(entry, "first", "alpha")).toBe("<p>alpha</p>");
    expect(markdown(entry, "second", "beta")).toBe("<p>beta</p>");
    expect(markdown(entry, "first", "alpha")).toBe("<p>alpha</p>");
    expect(markdown(entry, "second", "beta")).toBe("<p>beta</p>");

    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("reparses unchanged content when the configured parser revision changes", () => {
    const parse = vi.fn((content: string) => `<p>${content}</p>`);
    let parserRevision: object = {};
    const markdown = createEntryMarkdownCache(parse, () => parserRevision);
    const entry = { id: "entry-1" };

    markdown(entry, "body", "unchanged");
    markdown(entry, "body", "unchanged");
    parserRevision = {};
    markdown(entry, "body", "unchanged");

    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("does not share cached Markdown between replacement objects with the same ID", () => {
    const parse = vi.fn((content: string) => `<p>${content}</p>`);
    const markdown = createEntryMarkdownCache(parse);
    const original = { id: "shared-id" };
    const replacement = { id: "shared-id" };

    markdown(original, "body", "unchanged");
    markdown(original, "body", "unchanged");
    markdown(replacement, "body", "unchanged");

    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("reparses changed content in the same slot on the same entry object", () => {
    const parse = vi.fn((content: string) => `<p>${content}</p>`);
    const markdown = createEntryMarkdownCache(parse);
    const entry = { id: "entry-1" };

    expect(markdown(entry, 0, "before")).toBe("<p>before</p>");
    expect(markdown(entry, 0, "after")).toBe("<p>after</p>");
    expect(markdown(entry, 0, "after")).toBe("<p>after</p>");

    expect(parse.mock.calls.map(([content]) => content)).toEqual(["before", "after"]);
  });
});
