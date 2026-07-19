export type UnknownRecord = Record<string, unknown>;

export interface ContentBlock extends UnknownRecord {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  text?: string;
}

export interface SessionMessage extends UnknownRecord {
  role?: string;
  content?: string | ReadonlyArray<ContentBlock>;
  toolCallId?: string;
  provider?: string;
  model?: string;
  usage?: UnknownRecord;
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  isError?: boolean;
  isRunning?: boolean;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
}

export interface SessionEntry extends UnknownRecord {
  id: string;
  type?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: SessionMessage;
  targetId?: string;
  label?: string;
  customType?: string;
  content?: string | ReadonlyArray<ContentBlock>;
  details?: UnknownRecord;
  provider?: string;
  modelId?: string;
  summary?: string;
  thinkingLevel?: string;
  tokensBefore?: number;
}

export interface ToolCallInfo {
  readonly name: unknown;
  readonly arguments: unknown;
}

export interface SessionPayload extends UnknownRecord {
  header?: UnknownRecord | null;
  entries?: SessionEntry[] | null;
  leafId?: string | null;
  systemPrompt?: unknown;
  tools?: unknown;
  renderedTools?: unknown;
  total?: number | null;
  from?: number | null;
  truncated?: boolean | null;
}

export interface SessionDataShape extends SessionPayload {
  defaultLeafId?: string;
  urlLeafId?: string | null;
  urlTargetId?: string | null;
}

export const isUnknownRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const contentBlockFromUnknown = (value: unknown): ContentBlock | null => {
  if (!isUnknownRecord(value)) return null;
  return {
    ...value,
    type: typeof value.type === "string" ? value.type : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    arguments: value.arguments,
    text: typeof value.text === "string" ? value.text : undefined,
  };
};

export const contentBlocksFromUnknown = (value: unknown): ContentBlock[] =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const block = contentBlockFromUnknown(candidate);
        return block ? [block] : [];
      })
    : [];

export const sessionEntryFromUnknown = (value: unknown): SessionEntry | null => {
  if (!isUnknownRecord(value) || typeof value.id !== "string") return null;
  return {
    ...value,
    id: value.id,
    type: typeof value.type === "string" ? value.type : undefined,
    parentId:
      typeof value.parentId === "string" || value.parentId === null ? value.parentId : undefined,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
    message: isUnknownRecord(value.message)
      ? {
          ...value.message,
          content:
            typeof value.message.content === "string"
              ? value.message.content
              : Array.isArray(value.message.content)
                ? contentBlocksFromUnknown(value.message.content)
                : undefined,
        }
      : undefined,
    details: isUnknownRecord(value.details) ? { ...value.details } : undefined,
    content:
      typeof value.content === "string"
        ? value.content
        : Array.isArray(value.content)
          ? contentBlocksFromUnknown(value.content)
          : undefined,
  };
};
