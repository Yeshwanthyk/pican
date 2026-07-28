import { getContext, setContext } from "svelte";
import { Option, Schema } from "effect";

const APPLICATION_CONTEXT_ID = "pican-application-context";
const APPLICATION_CONTEXT_KEY = Symbol("pican-application-context");

export type ApplicationMode = "standalone" | "hosted";

const ApplicationContextSchema = Schema.Struct({
  mode: Schema.Literals(["standalone", "hosted"]),
  hostNavigationUrl: Schema.optionalKey(Schema.String),
});
export type ApplicationContext = typeof ApplicationContextSchema.Type;

export const DEFAULT_APPLICATION_CONTEXT: ApplicationContext = Object.freeze({
  mode: "standalone",
});

const decodeApplicationContext = Schema.decodeUnknownOption(ApplicationContextSchema);
const decodeSerializedApplicationContext = Schema.decodeUnknownOption(
  Schema.fromJsonString(ApplicationContextSchema),
);

function validHostNavigationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (candidate.startsWith("/") && !candidate.startsWith("//")) return candidate;
  if (!URL.canParse(candidate)) return undefined;

  const parsed = new URL(candidate);
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === ""
  ) {
    return candidate;
  }
  return undefined;
}

export function parseApplicationContext(value: unknown): ApplicationContext {
  const decoded = Option.getOrUndefined(decodeApplicationContext(value));
  if (!decoded) return DEFAULT_APPLICATION_CONTEXT;

  const hostNavigationUrl = validHostNavigationUrl(decoded.hostNavigationUrl);
  return Object.freeze({
    mode: decoded.mode,
    ...(hostNavigationUrl ? { hostNavigationUrl } : {}),
  });
}

export function readApplicationContext(source?: ParentNode): ApplicationContext {
  const root = source ?? (typeof document === "undefined" ? undefined : document);
  const raw = root?.querySelector<HTMLScriptElement>(`#${APPLICATION_CONTEXT_ID}`)?.textContent;
  if (!raw) return DEFAULT_APPLICATION_CONTEXT;
  const decoded = Option.getOrUndefined(decodeSerializedApplicationContext(raw));
  return decoded ? parseApplicationContext(decoded) : DEFAULT_APPLICATION_CONTEXT;
}

export function bootWithApplicationContext<T>(
  mount: (context: ApplicationContext) => T,
  source?: ParentNode,
): T {
  return mount(readApplicationContext(source));
}

export function provideApplicationContext(context: ApplicationContext): void {
  setContext(APPLICATION_CONTEXT_KEY, context);
}

export function getApplicationContext(): ApplicationContext {
  return (
    getContext<ApplicationContext | undefined>(APPLICATION_CONTEXT_KEY) ??
    DEFAULT_APPLICATION_CONTEXT
  );
}
