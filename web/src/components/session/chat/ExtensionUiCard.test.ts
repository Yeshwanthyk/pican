import { Schema } from "effect";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import ExtensionUiCard from "./ExtensionUiCard.svelte";
import type { ExtensionRequest } from "./extension-ui-state.js";

afterEach(cleanup);

function createFetch() {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
  );
}

function setup(request: ExtensionRequest) {
  const fetchImpl = createFetch();
  const view = render(ExtensionUiCard, { props: { request, sessionId: "s1", fetchImpl } });
  return { ...view, fetchImpl };
}

const SentBodySchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeSentBody = Schema.decodeUnknownSync(Schema.fromJsonString(SentBodySchema));

function sentBody(fetchImpl: ReturnType<typeof createFetch>) {
  const call = fetchImpl.mock.calls[0];
  assert(call);
  const init = call[1];
  assert(init);
  assert(typeof init.body === "string");
  return decodeSentBody(init.body);
}

describe("ExtensionUiCard", () => {
  it("submits confirm and cancel as booleans", async () => {
    const { getByText, fetchImpl } = setup({
      id: "c1",
      method: "confirm",
      title: "Deploy?",
      message: "Ship it",
    });
    expect(getByText("Ship it")).toBeTruthy();
    await fireEvent.click(getByText("Cancel"));
    expect(sentBody(fetchImpl)).toEqual({ session: "s1", id: "c1", confirmed: false });
  });

  it("submits the selected option", async () => {
    const { getByText, fetchImpl } = setup({
      id: "s1",
      method: "select",
      title: "Choose",
      options: ["One", "Two"],
    });
    await fireEvent.click(getByText("Two"));
    expect(sentBody(fetchImpl).value).toBe("Two");
  });

  it("submits single-line input", async () => {
    const { getByPlaceholderText, getByText, fetchImpl } = setup({
      id: "i1",
      method: "input",
      title: "Name",
      placeholder: "Ada",
    });
    await fireEvent.input(getByPlaceholderText("Ada"), { target: { value: "Grace" } });
    await fireEvent.click(getByText("Send"));
    expect(sentBody(fetchImpl).value).toBe("Grace");
  });

  it("prefills and submits editor text", async () => {
    const { container, getByText, fetchImpl } = setup({
      id: "e1",
      method: "editor",
      title: "Edit",
      prefill: "draft",
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    assert(textarea);
    expect(textarea.value).toBe("draft");
    await fireEvent.click(getByText("Send"));
    expect(sentBody(fetchImpl).value).toBe("draft");
  });
});
