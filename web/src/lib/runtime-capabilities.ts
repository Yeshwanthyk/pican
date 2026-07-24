import type { RuntimeCapabilities } from "./schema";

export type CompleteRuntimeCapabilities = Readonly<Required<RuntimeCapabilities>>;

const none: CompleteRuntimeCapabilities = {
  create: false,
  resume: false,
  fork: false,
  clone: false,
  rename: false,
  archive: false,
  unarchive: false,
  delete: false,
  chat: false,
  cancel: false,
  steer: false,
  persistentQueue: false,
  images: false,
  files: false,
  modelListing: false,
  modelSwitching: false,
  effortSelection: false,
  reasoningSelection: false,
  slashCommands: false,
  subagents: false,
  interactiveApprovals: false,
  userQuestions: false,
};

const pi: CompleteRuntimeCapabilities = {
  ...none,
  create: true,
  resume: true,
  fork: true,
  clone: true,
  rename: true,
  chat: true,
  cancel: true,
  steer: true,
  persistentQueue: true,
  images: true,
  files: true,
  modelListing: true,
  modelSwitching: true,
  reasoningSelection: true,
  slashCommands: true,
  subagents: true,
  interactiveApprovals: true,
  userQuestions: true,
};

const claude: CompleteRuntimeCapabilities = {
  ...none,
  create: true,
  resume: true,
  chat: true,
  cancel: true,
  images: true,
  files: true,
  modelListing: true,
};

const codex: CompleteRuntimeCapabilities = {
  ...none,
  create: true,
  resume: true,
  fork: true,
  clone: true,
  rename: true,
  archive: true,
  unarchive: true,
  delete: true,
  chat: true,
  cancel: true,
  steer: true,
  persistentQueue: true,
  images: true,
  files: true,
  modelListing: true,
  modelSwitching: true,
  effortSelection: true,
  reasoningSelection: true,
  slashCommands: true,
};

export const defaultRuntimeCapabilities = (runtime = "pi"): CompleteRuntimeCapabilities =>
  runtime === "pi" ? pi : runtime === "codex" ? codex : runtime === "claude" ? claude : none;

export const normalizeRuntimeCapabilities = (
  capabilities: RuntimeCapabilities | undefined,
  runtime = "",
): CompleteRuntimeCapabilities => {
  const defaults = capabilities === undefined ? defaultRuntimeCapabilities(runtime) : none;
  return {
    create: capabilities?.create ?? defaults.create,
    resume: capabilities?.resume ?? defaults.resume,
    fork: capabilities?.fork ?? defaults.fork,
    clone: capabilities?.clone ?? defaults.clone,
    rename: capabilities?.rename ?? defaults.rename,
    archive: capabilities?.archive ?? defaults.archive,
    unarchive: capabilities?.unarchive ?? defaults.unarchive,
    delete: capabilities?.delete ?? defaults.delete,
    chat: capabilities?.chat ?? defaults.chat,
    cancel: capabilities?.cancel ?? defaults.cancel,
    steer: capabilities?.steer ?? defaults.steer,
    persistentQueue: capabilities?.persistentQueue ?? defaults.persistentQueue,
    images: capabilities?.images ?? defaults.images,
    files: capabilities?.files ?? defaults.files,
    modelListing: capabilities?.modelListing ?? defaults.modelListing,
    modelSwitching: capabilities?.modelSwitching ?? defaults.modelSwitching,
    effortSelection: capabilities?.effortSelection ?? defaults.effortSelection,
    reasoningSelection: capabilities?.reasoningSelection ?? defaults.reasoningSelection,
    slashCommands: capabilities?.slashCommands ?? defaults.slashCommands,
    subagents: capabilities?.subagents ?? defaults.subagents,
    interactiveApprovals: capabilities?.interactiveApprovals ?? defaults.interactiveApprovals,
    userQuestions: capabilities?.userQuestions ?? defaults.userQuestions,
  };
};
