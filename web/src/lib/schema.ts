import { Schema } from "effect";

const optionalString = Schema.optionalKey(Schema.String);
const optionalNumber = Schema.optionalKey(Schema.Number);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const optionalNullableString = Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]));
const optionalNullableNumber = Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null]));
const optionalNullableBoolean = Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null]));
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const SessionSchema = Schema.Struct({
  id: optionalNullableString,
  ID: optionalNullableString,
  sessionUUID: optionalNullableString,
  SessionUUID: optionalNullableString,
  filename: optionalNullableString,
  Filename: optionalNullableString,
  project: optionalNullableString,
  Project: optionalNullableString,
  lastActivity: optionalNullableString,
  LastActivity: optionalNullableString,
  name: optionalNullableString,
  Name: optionalNullableString,
  messageCount: optionalNullableNumber,
  MessageCount: optionalNullableNumber,
  tokenTotal: optionalNullableNumber,
  TokenTotal: optionalNullableNumber,
  costTotal: optionalNullableNumber,
  CostTotal: optionalNullableNumber,
  model: optionalNullableString,
  Model: optionalNullableString,
  modelProvider: optionalNullableString,
  ModelProvider: optionalNullableString,
  runtime: optionalNullableString,
  Runtime: optionalNullableString,
  nativeId: optionalNullableString,
  NativeID: optionalNullableString,
  chatAvailable: optionalNullableBoolean,
  ChatAvailable: optionalNullableBoolean,
  chatDisabledReason: optionalNullableString,
  ChatDisabledReason: optionalNullableString,
  pinned: optionalNullableBoolean,
  Pinned: optionalNullableBoolean,
  host: optionalNullableString,
  hostUrl: optionalNullableString,
  header: Schema.optionalKey(UnknownRecord),
  Header: Schema.optionalKey(UnknownRecord),
  entries: Schema.optionalKey(Schema.Array(UnknownRecord)),
  Entries: Schema.optionalKey(Schema.Array(UnknownRecord)),
});
export type Session = typeof SessionSchema.Type;

export const SessionListSchema = Schema.Struct({
  sessions: Schema.Array(SessionSchema),
  total: Schema.optionalKey(Schema.Number),
});
export type SessionList = typeof SessionListSchema.Type;

export const ProjectSchema = Schema.Struct({
  path: Schema.String,
  enabled: Schema.Boolean,
  sessionCount: Schema.Number,
  source: Schema.String,
});
export type Project = typeof ProjectSchema.Type;
export const ProjectListSchema = Schema.Struct({
  projects: Schema.Array(ProjectSchema),
  filterEnabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectList = typeof ProjectListSchema.Type;

export const ScheduleSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelProvider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: Schema.String,
  projectPath: Schema.String,
  cronExpr: Schema.String,
  timezone: Schema.String,
  enabled: Schema.Boolean,
  lastRunAt: optionalString,
  nextRunAt: optionalString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Schedule = typeof ScheduleSchema.Type;
export const ScheduleListSchema = Schema.Struct({ schedules: Schema.Array(ScheduleSchema) });
export type ScheduleList = typeof ScheduleListSchema.Type;

export const ScheduleRunSchema = Schema.Struct({
  id: Schema.Number,
  scheduleId: Schema.String,
  sessionId: optionalString,
  sessionFile: optionalString,
  firedAt: Schema.String,
  status: Schema.String,
  error: optionalString,
});
export type ScheduleRun = typeof ScheduleRunSchema.Type;
export const ScheduleRunListSchema = Schema.Struct({ runs: Schema.Array(ScheduleRunSchema) });
export type ScheduleRunList = typeof ScheduleRunListSchema.Type;

export const QueueItemSchema = Schema.Struct({
  sessionId: Schema.String,
  position: Schema.Number,
  message: Schema.String,
  displayText: Schema.String,
  createdAt: Schema.String,
});
export type QueueItem = typeof QueueItemSchema.Type;
export const QueueStateSchema = Schema.Struct({
  items: Schema.Array(QueueItemSchema),
  paused: Schema.Boolean,
});
export type QueueState = typeof QueueStateSchema.Type;

export const DirEntrySchema = Schema.Struct({
  name: Schema.String,
  fullPath: Schema.String,
  isParent: Schema.optionalKey(Schema.Boolean),
});
export type DirEntry = typeof DirEntrySchema.Type;
export const DirBrowseSchema = Schema.Struct({
  parentPath: Schema.String,
  entries: Schema.Array(DirEntrySchema),
  exists: Schema.Boolean,
});
export type DirBrowse = typeof DirBrowseSchema.Type;

export const VersionInfoSchema = Schema.Struct({
  current: Schema.String,
  latest: Schema.String,
  hasUpdate: Schema.Boolean,
  isDev: Schema.Boolean,
  changelog: Schema.String,
  changelogUrl: Schema.String,
  checkedAt: Schema.String,
});
export type VersionInfo = typeof VersionInfoSchema.Type;

export const TaskExecutionSchema = Schema.StructWithRest(
  Schema.Struct({
    startedAt: optionalString,
    completedAt: optionalString,
    exitCode: optionalNumber,
    outputPath: optionalString,
    outputFile: optionalString,
    status: optionalString,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export const TaskSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    subject: optionalString,
    description: optionalString,
    status: Schema.optionalKey(Schema.String),
    owner: optionalString,
    agentType: optionalString,
    execution: Schema.optionalKey(Schema.Union([TaskExecutionSchema, Schema.Null])),
    blockedBy: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
    updatedAt: optionalString,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type Task = typeof TaskSchema.Type;
export const TaskStoreSchema = Schema.Struct({
  path: Schema.String,
  scope: Schema.Literals(["project", "session", "global"]),
  sessionId: Schema.String,
  tasks: Schema.Array(TaskSchema),
});
export const TaskListSchema = Schema.Struct({ stores: Schema.Array(TaskStoreSchema) });
export type TaskList = typeof TaskListSchema.Type;

export const WorkflowRunSchema = Schema.Struct({
  runId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  status: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  currentPhase: Schema.String,
  currentPhaseNumber: Schema.optionalKey(Schema.Number),
  phaseCount: Schema.optionalKey(Schema.Number),
  agentCount: Schema.optionalKey(Schema.Number),
  hasResult: Schema.optionalKey(Schema.Boolean),
  hasTranscripts: Schema.optionalKey(Schema.Boolean),
});
export type WorkflowRun = typeof WorkflowRunSchema.Type;
export const WorkflowRunListSchema = Schema.Struct({ workflows: Schema.Array(WorkflowRunSchema) });
export type WorkflowRunList = typeof WorkflowRunListSchema.Type;
export const WorkflowRunDetailSchema = Schema.Struct({
  workflow: UnknownRecord,
  transcripts: Schema.Union([Schema.Unknown, Schema.Null]),
  result: Schema.Union([Schema.Unknown, Schema.Null]),
  script: Schema.Union([Schema.String, Schema.Null]),
});
export type WorkflowRunDetail = typeof WorkflowRunDetailSchema.Type;

export const SubagentSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  harness: Schema.String,
  status: Schema.Literals(["running", "done", "error", "unknown"]),
  spawnedAt: Schema.String,
  parentSession: Schema.String,
  parentProject: Schema.String,
  childSession: Schema.String,
  childProject: Schema.String,
  lastActivity: Schema.String,
});
export const SubagentListSchema = Schema.Struct({ subagents: Schema.Array(SubagentSchema) });
export type SubagentList = typeof SubagentListSchema.Type;

export const PeerSchema = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
  hasToken: Schema.Boolean,
});
export const PeerListSchema = Schema.Struct({ peers: Schema.Array(PeerSchema) });
export type PeerList = typeof PeerListSchema.Type;
export const PeerHostSchema = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
  online: Schema.Boolean,
  error: Schema.String,
  sessions: Schema.Array(SessionSchema),
});
export const PeerSessionListSchema = Schema.Struct({ hosts: Schema.Array(PeerHostSchema) });

export const RuntimeInfoSchema = Schema.Struct({
  id: Schema.String,
  available: optionalBoolean,
  reason: optionalString,
  capabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export const RuntimesResponseSchema = Schema.Struct({
  defaultRuntime: optionalString,
  runtimes: Schema.optionalKey(Schema.Array(RuntimeInfoSchema)),
});
export type RuntimesResponse = typeof RuntimesResponseSchema.Type;
export const RecentLocationSchema = Schema.Union([
  Schema.String,
  Schema.StructWithRest(Schema.Struct({ path: Schema.String }), [UnknownRecord]),
]);
export const RecentLocationsSchema = Schema.Struct({
  locations: Schema.Array(RecentLocationSchema),
});
export type RecentLocations = typeof RecentLocationsSchema.Type;

export const ModelSchema = Schema.StructWithRest(
  Schema.Struct({
    provider: optionalString,
    id: optionalString,
    modelId: optionalString,
    name: optionalString,
    thinkingLevels: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [UnknownRecord],
);
export const ModelListSchema = Schema.Struct({ models: Schema.Array(ModelSchema) });
export type ModelList = typeof ModelListSchema.Type;

export const GitInfoSchema = Schema.Struct({
  isRepo: Schema.Boolean,
  branch: Schema.String,
  isDefault: Schema.Boolean,
  hasChanges: Schema.Boolean,
  prCreateUrl: Schema.String,
  prUrl: Schema.String,
});
export type GitInfo = typeof GitInfoSchema.Type;
export const GitDiffSchema = Schema.Union([
  Schema.Struct({ isRepo: Schema.Literal(true), diff: Schema.String, branch: Schema.String }),
  Schema.Struct({ isRepo: Schema.Literal(false), diff: Schema.String }),
]);
export type GitDiff = typeof GitDiffSchema.Type;

export const MutationResponseSchema = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  status: optionalString,
  id: optionalString,
  name: optionalString,
  sessionId: optionalString,
  removed: Schema.optionalKey(Schema.Boolean),
  paused: Schema.optionalKey(Schema.Boolean),
  needsRestart: Schema.optionalKey(Schema.Boolean),
});
export type MutationResponse = typeof MutationResponseSchema.Type;
export const ApiErrorBodySchema = Schema.Struct({ error: Schema.optionalKey(Schema.Unknown) });
export const OkResponseSchema = Schema.Struct({ ok: Schema.Boolean });
export const NewSessionResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  id: Schema.String,
});
export const ProjectMutationResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  filterEnabled: Schema.optionalKey(Schema.Boolean),
});
export const PinMutationResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  pinned: Schema.Boolean,
});
export const PeerMutationResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  name: Schema.String,
});
export const ScheduleMutationResponseSchema = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(ScheduleSchema),
  runId: optionalString,
});
export const ScheduleRunResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  sessionId: Schema.String,
});
export const QueueMutationResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  removed: Schema.optionalKey(Schema.Boolean),
  paused: Schema.optionalKey(Schema.Boolean),
  item: Schema.optionalKey(QueueItemSchema),
});
export const QueueRemoveResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  removed: Schema.Boolean,
});
export const QueuePauseResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  paused: Schema.Boolean,
});
export const GitRenameResponseSchema = Schema.Struct({ ok: Schema.Boolean, branch: Schema.String });
export const SettingsResponseSchema = Schema.Struct({
  settings: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Null])),
});

export const NewSessionRequestSchema = Schema.Struct({
  path: Schema.String,
  runtime: Schema.String,
});
export const ProjectMutationRequestSchema = Schema.Struct({
  path: Schema.String,
  action: Schema.String,
});
export const PinMutationRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  pinned: Schema.Boolean,
});
export const PeerUpsertRequestSchema = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
  token: Schema.String,
});
export const PeerRemoveRequestSchema = Schema.Struct({
  name: Schema.String,
  action: Schema.Literal("remove"),
});
export const ScheduleMutationRequestSchema = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
  modelProvider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: Schema.String,
  projectPath: Schema.String,
  cronExpr: Schema.String,
  timezone: Schema.String,
  enabled: Schema.Boolean,
  lastRunAt: optionalString,
  nextRunAt: optionalString,
});
export const QueueAddRequestSchema = Schema.Struct({
  message: Schema.String,
  displayText: Schema.String,
});
export const QueuePauseRequestSchema = Schema.Struct({ paused: Schema.Boolean });
export const ModelMutationRequestSchema = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
});
export const ThinkingMutationRequestSchema = Schema.Struct({ level: Schema.String });

export const StatusSnapshotSchema = Schema.Struct({
  running: Schema.Array(Schema.String),
  statuses: Schema.Record(Schema.String, UnknownRecord),
});
export const StatusDeltaSchema = Schema.Struct({
  id: Schema.String,
  running: Schema.Boolean,
  model: optionalString,
  modelName: optionalString,
  modelProvider: optionalString,
});
export const WorkflowUpdatedSchema = Schema.Struct({ runId: Schema.String });
export const TasksUpdatedSchema = Schema.Struct({ project: Schema.String });
