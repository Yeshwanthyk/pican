import { describe, expect, it } from "vitest";
import { formatToolRunBreakdown, groupToolRuns } from "./group-tool-runs.js";

const user = (id: string) => ({
  id,
  type: "message",
  message: { role: "user", content: "Keep going" },
});
const assistantText = (id: string, text = "Done") => ({
  id,
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const assistantTools = (
  id: string,
  names: ReadonlyArray<string>,
  { thinking = false }: { readonly thinking?: boolean } = {},
) => ({
  id,
  type: "message",
  message: {
    role: "assistant",
    content: [
      ...(thinking ? [{ type: "thinking", thinking: "Working" }] : []),
      ...names.map((name, index) => ({ type: "toolCall", id: `${id}-${index}`, name })),
    ],
  },
});
const toolResult = (id: string) => ({
  id,
  type: "message",
  message: { role: "toolResult", toolCallId: `call-${id}`, content: [] },
});
const toolResultFor = (id: string, { isError = false }: { readonly isError?: boolean } = {}) => ({
  id: `result-${id}`,
  type: "message",
  message: { role: "toolResult", toolCallId: id, content: [], isError },
});
const bashExecution = (id: string) => ({
  id,
  type: "message",
  message: { role: "bashExecution", command: "pwd", output: "", exitCode: 0 },
});
const subagentResult = (id: string) => ({
  id,
  type: "custom_message",
  customType: "subagent-result",
  content: "Done",
});

describe("groupToolRuns", () => {
  it("collapses a run with more than four tool calls and builds a ranked breakdown", () => {
    const entries = [
      assistantTools("a1", ["bash", "read", "bash"]),
      toolResult("r1"),
      bashExecution("b1"),
      subagentResult("s1"),
      assistantTools("a2", ["edit", "bash", "read"]),
    ];

    const groups = groupToolRuns(entries);
    const group = groups[0];
    expect(group).toMatchObject({
      kind: "group",
      entries: entries.slice(0, 2),
      toolCount: 3,
      breakdown: {
        tools: [
          { name: "bash", count: 2 },
          { name: "read", count: 1 },
        ],
        remaining: 0,
      },
    });
    expect(formatToolRunBreakdown(group?.kind === "group" ? group.breakdown : undefined)).toBe(
      "bash x2, read x1",
    );
    expect(groups).toMatchObject([
      { kind: "group" },
      { kind: "entry", entry: entries[2] },
      { kind: "entry", entry: entries[3] },
      { kind: "group", entries: [entries[4]], toolCount: 3 },
    ]);
  });

  it("does not merge tool runs across assistant prose", () => {
    const first = assistantTools("a1", ["bash", "bash", "read"]);
    const prose = assistantText("a2");
    const second = assistantTools("a3", ["edit", "edit", "read"]);

    expect(groupToolRuns([first, prose, second])).toMatchObject([
      { kind: "group", entries: [first], toolCount: 3 },
      { kind: "entry", entry: prose },
      { kind: "group", entries: [second], toolCount: 3 },
    ]);
  });

  it("collapses a run as soon as it contains two tool calls", () => {
    const entries = [assistantTools("a1", ["bash"]), assistantTools("a2", ["edit"])];
    expect(groupToolRuns(entries)).toMatchObject([{ kind: "group", entries, toolCount: 2 }]);
  });

  it("folds a single tool call into the turn activity", () => {
    const entry = assistantTools("a1", ["bash"]);
    expect(groupToolRuns([entry])).toMatchObject([
      { kind: "group", entries: [entry], toolCount: 1, durationSeconds: 0 },
    ]);
  });

  it("always breaks runs at user messages", () => {
    const first = assistantTools("a1", ["bash", "bash", "bash"]);
    const prompt = user("u1");
    const second = assistantTools("a2", ["read", "read", "read"]);

    expect(groupToolRuns([first, prompt, second])).toMatchObject([
      { kind: "group", entries: [first], toolCount: 3 },
      { kind: "entry", entry: prompt },
      { kind: "group", entries: [second], toolCount: 3 },
    ]);
  });

  it("groups mixed tool and thinking-only assistant messages", () => {
    const entries = [
      assistantTools("a1", ["bash", "read"], { thinking: true }),
      assistantTools("thinking", [], { thinking: true }),
      assistantTools("a2", ["edit", "write", "ls"]),
    ];

    expect(groupToolRuns(entries)).toMatchObject([{ kind: "group", entries, toolCount: 5 }]);
  });

  it("keeps a pending interactive tool visible, then groups it after completion", () => {
    const prior = assistantTools("prior", ["bash", "edit"]);
    const priorResults = [toolResultFor("prior-0"), toolResultFor("prior-1")];
    const prompt = assistantTools("prompt", ["ask_user"]);

    expect(groupToolRuns([prior, ...priorResults, prompt])).toMatchObject([
      { kind: "group", toolCount: 2, status: "success" },
      { kind: "entry", entry: prompt },
    ]);

    expect(
      groupToolRuns([prior, ...priorResults, prompt, toolResultFor("prompt-0")]),
    ).toMatchObject([{ kind: "group", toolCount: 3, status: "success" }]);
  });

  it("marks failed groups so the renderer can open them", () => {
    const calls = assistantTools("a1", ["bash", "edit"]);
    const [group] = groupToolRuns([
      calls,
      toolResultFor("a1-0"),
      toolResultFor("a1-1", { isError: true }),
    ]);

    expect(group).toMatchObject({ kind: "group", status: "error" });
  });

  it("groups leading and trailing runs independently", () => {
    const leading = [
      toolResult("r0"),
      assistantTools("a1", ["bash", "bash", "bash", "bash", "bash"]),
    ];
    const prose = assistantText("a2");
    const trailing = [
      assistantTools("a3", ["read", "read", "read"]),
      toolResult("r1"),
      assistantTools("a4", ["edit", "edit"]),
    ];

    expect(groupToolRuns([...leading, prose, ...trailing])).toMatchObject([
      { kind: "entry", entry: leading[0] },
      { kind: "group", entries: [leading[1]], toolCount: 5 },
      { kind: "entry", entry: prose },
      { kind: "group", entries: trailing, toolCount: 5 },
    ]);
  });

  it("does not create an empty fold for a result after prose with embedded activity", () => {
    const mixed = {
      id: "mixed",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "mixed-call", name: "edit" },
          { type: "text", text: "Done" },
        ],
      },
    };
    const result = toolResultFor("mixed-call");

    expect(groupToolRuns([mixed, result])).toMatchObject([
      { kind: "entry", entry: mixed },
      { kind: "entry", entry: result },
    ]);
  });

  it("limits the breakdown to four tool names", () => {
    const [group] = groupToolRuns([assistantTools("a1", ["bash", "read", "edit", "write", "ls"])]);
    expect(group?.kind === "group" ? group.breakdown.remaining : 0).toBe(1);
    expect(
      formatToolRunBreakdown(group?.kind === "group" ? group.breakdown : undefined, "+1 more"),
    ).toBe("bash x1, read x1, edit x1, write x1, +1 more");
  });
});
