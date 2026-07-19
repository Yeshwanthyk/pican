import { describe, expect, it } from "vitest";
import { HttpError, WorkerDownError, describeError } from "./errors";

describe("describeError", () => {
  it("renders plain worker-down copy and safely handles unknown values", () => {
    expect(describeError(new WorkerDownError({ code: 9 }))).toBe(
      "worker exited (9) — stream ended here",
    );
    expect(describeError("unexpected")).toBe("something went wrong");
  });

  it("exposes useful HTTP status refinements", () => {
    const error = new HttpError({ status: 503, url: "/api/sessions", body: "down" });
    expect(error.isServerError).toBe(true);
    expect(error.isNotFound).toBe(false);
  });
});
