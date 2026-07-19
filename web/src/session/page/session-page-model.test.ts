import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRuntime, hydrateSessionModel } from "./session-page-model.js";
import { resetSessionRuntimeContext } from "../session-runtime-context.js";

interface TestSessionModel {
  load(value: unknown): void;
  reconcile(entries: ReadonlyArray<unknown>, options?: unknown): unknown;
  header?: { readonly cwd?: string };
  leafId?: string;
  urlTargetId?: string;
  currentLeafId?: string;
  currentTargetId?: string;
  [key: string]: unknown;
}

function encodeJSON(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

function createTestModel(): TestSessionModel {
  const sessionModel: TestSessionModel = {
    load: vi.fn((data: unknown) => {
      if (typeof data === "object" && data !== null) Object.assign(sessionModel, data);
    }),
    reconcile: vi.fn((entries: ReadonlyArray<unknown>) => entries),
  };
  return sessionModel;
}

describe("session page model helpers", () => {
  it("hydrates the reactive model from the encoded payload and creates runtime hooks", () => {
    const payloadBase64 = encodeJSON({
      header: { cwd: "/tmp/project" },
      entries: [{ id: "root" }, { id: "leaf" }],
      leafId: "leaf",
    });
    const sessionModel = createTestModel();

    hydrateSessionModel({
      sessionModel,
      payloadBase64,
      locationSearch: "?leafId=root&targetId=leaf",
      windowImpl: window,
    });

    expect(sessionModel.load).toHaveBeenCalledOnce();
    expect(sessionModel.header?.cwd).toBe("/tmp/project");
    expect(sessionModel.leafId).toBe("root");
    expect(sessionModel.urlTargetId).toBe("leaf");

    const runtime = createLiveSessionRuntime({
      sessionModel,
      contentRuntime: { afterRender: null },
      documentImpl: document,
    });

    runtime.navigateTo("leaf", "none");
    runtime.reconcileEntries([{ id: "next" }]);

    expect(sessionModel.currentLeafId).toBe("leaf");
    expect(sessionModel.currentTargetId).toBe("leaf");
    expect(sessionModel.reconcile).toHaveBeenCalledWith([{ id: "next" }], undefined);

    resetSessionRuntimeContext();
  });

  it("passes reconcile options (e.g. isDelta) through to the model", () => {
    const payloadBase64 = encodeJSON({
      header: {},
      entries: [{ id: "root" }],
      leafId: "root",
    });
    const sessionModel = createTestModel();

    hydrateSessionModel({ sessionModel, payloadBase64, windowImpl: window });
    const runtime = createLiveSessionRuntime({
      sessionModel,
      contentRuntime: { afterRender: null },
      documentImpl: document,
    });

    runtime.reconcileEntries([{ id: "next" }], { isDelta: true });
    expect(sessionModel.reconcile).toHaveBeenCalledWith([{ id: "next" }], { isDelta: true });

    resetSessionRuntimeContext();
  });
});
