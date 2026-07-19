import { describe, expect, it } from "vitest";
import { parseTaskLines } from "./task-tool.js";

describe("parseTaskLines", () => {
  it("parses task rows and preserves other lines", () => {
    expect(
      parseTaskLines(
        "Created tasks:\n#12 [pending] Add task renderer\n#13 [in_progress] Write tests\nDone.",
      ),
    ).toEqual({
      tasks: [
        { id: "12", status: "pending", subject: "Add task renderer" },
        { id: "13", status: "in_progress", subject: "Write tests" },
      ],
      passthroughLines: ["Created tasks:", "Done."],
    });
  });

  it("accepts completed tasks and CRLF text", () => {
    expect(parseTaskLines("#task-a [completed] Ship it\r\n")).toEqual({
      tasks: [{ id: "task-a", status: "completed", subject: "Ship it" }],
      passthroughLines: [""],
    });
  });

  it("does not parse malformed or unknown statuses", () => {
    const text = "#1 [blocked] Waiting\n#2 pending Missing brackets\nplain text";
    expect(parseTaskLines(text)).toEqual({
      tasks: [],
      passthroughLines: text.split("\n"),
    });
  });

  it("handles missing text", () => {
    expect(parseTaskLines()).toEqual({ tasks: [], passthroughLines: [""] });
  });
});
