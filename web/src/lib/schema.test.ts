import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runPromise } from "./runtime";
import {
  DirBrowseSchema,
  GitDiffSchema,
  GitInfoSchema,
  ModelListSchema,
  PeerSessionListSchema,
  RecentLocationsSchema,
  RuntimesResponseSchema,
  SessionSchema,
  TaskListSchema,
  WorkflowRunDetailSchema,
} from "./schema";

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, input: unknown) =>
  runPromise(Schema.decodeUnknownEffect(schema)(input));

describe("API schemas", () => {
  it("decodes the filesystem, runtime, recent-location, and model compatibility shapes", async () => {
    await expect(
      decode(DirBrowseSchema, { parentPath: "/tmp", entries: [], exists: true }),
    ).resolves.toMatchObject({ parentPath: "/tmp", exists: true });
    await expect(decode(RuntimesResponseSchema, {})).resolves.toEqual({});
    await expect(
      decode(RuntimesResponseSchema, {
        runtimes: [
          {
            id: "custom-runtime",
            label: "Custom Runtime",
            projectionMode: "replaceable-projection",
            capabilities: { create: true, chat: false, userQuestions: false },
          },
        ],
      }),
    ).resolves.toMatchObject({
      runtimes: [
        {
          id: "custom-runtime",
          label: "Custom Runtime",
          projectionMode: "replaceable-projection",
          capabilities: { create: true, chat: false, userQuestions: false },
        },
      ],
    });
    await expect(
      decode(RecentLocationsSchema, { locations: ["/one", { path: "/two", label: "Two" }] }),
    ).resolves.toMatchObject({ locations: ["/one", { path: "/two" }] });
    await expect(
      decode(ModelListSchema, { models: [{ modelId: "x", provider: "p", contextWindow: 1 }] }),
    ).resolves.toMatchObject({ models: [{ modelId: "x", contextWindow: 1 }] });
  });

  it("accepts mixed-case nullable session compatibility fields", async () => {
    await expect(
      decode(SessionSchema, { ID: "s.jsonl", model: null, ChatAvailable: null }),
    ).resolves.toMatchObject({ ID: "s.jsonl", model: null });
  });

  it("preserves peer host routing on aggregated sessions", async () => {
    await expect(
      decode(PeerSessionListSchema, {
        hosts: [
          {
            name: "desk",
            baseUrl: "https://desk",
            online: true,
            error: "",
            sessions: [{ id: "s.jsonl", host: "desk", hostUrl: "https://desk" }],
          },
        ],
      }),
    ).resolves.toMatchObject({
      hosts: [{ sessions: [{ host: "desk", hostUrl: "https://desk" }] }],
    });
  });

  it("decodes the audited git discriminants", async () => {
    await expect(
      decode(GitInfoSchema, {
        isRepo: true,
        branch: "main",
        isDefault: true,
        hasChanges: false,
        prCreateUrl: "",
        prUrl: "",
      }),
    ).resolves.toMatchObject({ isRepo: true, branch: "main" });
    await expect(
      decode(GitDiffSchema, { isRepo: true, diff: "patch", branch: "feature" }),
    ).resolves.toMatchObject({ isRepo: true, diff: "patch" });
  });

  it("preserves open task and workflow detail fields", async () => {
    await expect(
      decode(TaskListSchema, {
        stores: [
          {
            path: "/p",
            scope: "project",
            sessionId: "",
            tasks: [{ id: 1, custom: "kept", execution: { status: "running", extra: 3 } }],
          },
        ],
      }),
    ).resolves.toMatchObject({ stores: [{ tasks: [{ custom: "kept" }] }] });
    await expect(
      decode(WorkflowRunDetailSchema, {
        workflow: { runId: "wf_1", custom: true },
        transcripts: null,
        result: { ok: true },
        script: null,
      }),
    ).resolves.toMatchObject({ workflow: { custom: true }, script: null });
  });
});
