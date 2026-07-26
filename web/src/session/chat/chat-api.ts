import { Effect, Schema } from "effect";
import { AbortError, NetworkError } from "../../lib/errors";
import type { FetchLike } from "../../lib/http";
import { runPromise } from "../../lib/runtime";
import { withBasePath } from "../../shared/base-path";

interface FetchOptions {
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
}

interface ModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

const encodeJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const request = (
  url: string,
  init: RequestInit | undefined,
  { fetchImpl = globalThis.fetch, signal }: FetchOptions = {},
): Promise<Response> =>
  runPromise(
    Effect.callback<Response, NetworkError | AbortError>((resume, effectSignal) => {
      const requestSignal = init?.signal;
      const abort = () => {
        resume(new AbortError());
      };
      if (requestSignal?.aborted || signal?.aborted || effectSignal.aborted) {
        resume(new AbortError());
        return;
      }
      requestSignal?.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      effectSignal.addEventListener("abort", abort, { once: true });
      const mountedURL = withBasePath(url);
      const response = init === undefined ? fetchImpl(mountedURL) : fetchImpl(mountedURL, init);
      response.then(
        (response) => resume(Effect.succeed(response)),
        (cause) => resume(requestSignal?.aborted ? new AbortError() : new NetworkError({ cause })),
      );
      return Effect.sync(() => {
        requestSignal?.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
        effectSignal.removeEventListener("abort", abort);
      });
    }),
  );

const requestJson = (url: string, value: unknown, options: FetchOptions): Promise<Response> =>
  runPromise(
    encodeJson(value).pipe(
      Effect.flatMap((body) =>
        Effect.callback<Response, NetworkError>((resume) => {
          (options.fetchImpl ?? globalThis.fetch)(withBasePath(url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }).then(
            (response) => resume(Effect.succeed(response)),
            (cause) => resume(new NetworkError({ cause })),
          );
        }),
      ),
    ),
  );

export function chatUrl(path: string, sessionId: string): string {
  return `${path}?id=${encodeURIComponent(sessionId)}`;
}

export function cancelChat(sessionId: string, options: FetchOptions = {}): Promise<Response> {
  return request(chatUrl("/api/chat/cancel", sessionId), { method: "POST" }, options);
}

export function sendChat(
  sessionId: string,
  body: BodyInit | null,
  options: FetchOptions = {},
): Promise<Response> {
  return request(chatUrl("/api/chat", sessionId), { method: "POST", body }, options);
}

export function getWorkerStatus(sessionId: string, options: FetchOptions = {}): Promise<Response> {
  return request(chatUrl("/api/worker-status", sessionId), undefined, options);
}

export function listModels(sessionId = "", options: FetchOptions = {}): Promise<Response> {
  return request(sessionId ? chatUrl("/api/models", sessionId) : "/api/models", undefined, options);
}

export function getCommands(
  sessionId: string,
  { load = false }: { readonly load?: boolean } = {},
  options: FetchOptions = {},
): Promise<Response> {
  const url = chatUrl("/api/commands", sessionId) + (load ? "&load=1" : "");
  return request(url, options.signal ? { signal: options.signal } : undefined, options);
}

export function getFiles(
  sessionId: string,
  query: string,
  options: FetchOptions = {},
): Promise<Response> {
  const url = chatUrl("/api/files", sessionId) + "&q=" + encodeURIComponent(query || "");
  return request(url, { signal: options.signal }, options);
}

export function setModel(
  sessionId: string,
  { provider, modelId }: ModelSelection,
  options: FetchOptions = {},
): Promise<Response> {
  return requestJson(chatUrl("/api/set-model", sessionId), { provider, modelId }, options);
}

export function setThinkingLevel(
  sessionId: string,
  level: string,
  options: FetchOptions = {},
): Promise<Response> {
  return requestJson(chatUrl("/api/set-thinking-level", sessionId), { level }, options);
}
