import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup, fireEvent } from "@testing-library/svelte";
// @ts-ignore TypeScript's ambient *.svelte module omits module-script exports; svelte-check verifies it.
import ForkModal, { buildUserMessageList } from "./ForkModal.svelte";

afterEach(cleanup);

const entries = [
  { id: "a1", type: "message", message: { role: "user", content: "First request" } },
  { id: "b2", type: "message", message: { role: "assistant", content: "Ignore me" } },
  {
    id: "c3",
    type: "message",
    message: { role: "user", content: "Implement the palette redesign with keyboard nav" },
  },
];

describe("buildUserMessageList", () => {
  it("keeps only user messages, latest first, numbered in send order", () => {
    const list = buildUserMessageList(entries);
    expect(list.map((message: { readonly entryId: string }) => message.entryId)).toEqual([
      "c3",
      "a1",
    ]);
    expect(list.map((message: { readonly number: number }) => message.number)).toEqual([2, 1]);
  });
});

describe("ForkModal", () => {
  it("renders latest user messages first with a preview of the selection", async () => {
    render(ForkModal, { props: { open: true, entries } });
    await tick();
    const rows = [...document.querySelectorAll(".fork-message-item")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("#2");
    expect(rows[0]?.textContent).toContain("Implement the palette");
    expect(rows[1]?.textContent).toContain("#1");
    expect(document.querySelector(".fork-message-preview")?.textContent).toContain(
      "Implement the palette redesign",
    );
  });

  it("filters messages and selects the highlighted row with Enter", async () => {
    const onSelect = vi.fn();
    render(ForkModal, { props: { open: true, entries, onSelect } });
    await tick();
    const input = document.querySelector(".fork-search-input") ?? document.createElement("input");
    await fireEvent.input(input, { target: { value: "first" } });
    await tick();
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("a1");
  });
});
