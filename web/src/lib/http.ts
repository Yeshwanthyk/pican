import { Effect, Schema } from "effect";
import type { ApiError } from "./errors";
import { AbortError, DecodeError, HttpError, NetworkError, TimeoutError } from "./errors";
import { withBasePath } from "../shared/base-path";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
  readonly timeoutMillis?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

const decodeWith = Schema.decodeUnknownEffect;
const encodeJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const responseText = (response: Response): Effect.Effect<string, NetworkError> =>
  Effect.callback((resume) => {
    response.text().then(
      (body) => resume(Effect.succeed(body)),
      (cause) => resume(new NetworkError({ cause })),
    );
  });

const fetchResponse = (
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Effect.Effect<Response, NetworkError | AbortError> =>
  Effect.callback((resume, effectSignal) => {
    const controller = new AbortController();
    const requestSignal = init.signal;
    const abort = () => {
      controller.abort();
      resume(new AbortError());
    };
    if (requestSignal?.aborted || effectSignal.aborted) {
      resume(new AbortError());
      return;
    }
    requestSignal?.addEventListener("abort", abort, { once: true });
    effectSignal.addEventListener("abort", abort, { once: true });
    fetchImpl(withBasePath(url), { ...init, signal: controller.signal }).then(
      (response) => resume(Effect.succeed(response)),
      (cause) => resume(controller.signal.aborted ? new AbortError() : new NetworkError({ cause })),
    );
    return Effect.sync(() => {
      requestSignal?.removeEventListener("abort", abort);
      effectSignal.removeEventListener("abort", abort);
      controller.abort();
    });
  });

const request = Effect.fn("apiFetch.request")(function* <A, R>(
  method: string,
  url: string,
  schema: Schema.ConstraintDecoder<A, R>,
  body: unknown,
  options: RequestOptions,
): Effect.fn.Return<A, ApiError, R> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const encodedBody =
    body === undefined
      ? undefined
      : yield* encodeJson(body).pipe(
          Effect.mapError((issue) => new DecodeError({ url, issue: issue.message })),
        );
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (encodedBody !== undefined) headers["Content-Type"] = "application/json";

  let responseEffect: Effect.Effect<Response, NetworkError | AbortError | TimeoutError> =
    fetchResponse(url, { method, headers, body: encodedBody, signal: options.signal }, fetchImpl);
  if (options.timeoutMillis !== undefined) {
    responseEffect = responseEffect.pipe(
      Effect.timeoutOrElse({
        duration: options.timeoutMillis,
        orElse: () => Effect.fail(new TimeoutError({ url, millis: options.timeoutMillis ?? 0 })),
      }),
    );
  }

  const response = yield* responseEffect;
  const text = yield* responseText(response);
  if (!response.ok) {
    return yield* new HttpError({ status: response.status, url, body: text });
  }
  const jsonSchema = Schema.fromJsonString(schema);
  return yield* decodeWith(jsonSchema)(text).pipe(
    Effect.mapError((issue) => new DecodeError({ url, issue: issue.message })),
  );
});

export const get = <A, R>(
  url: string,
  schema: Schema.ConstraintDecoder<A, R>,
  options: RequestOptions = {},
): Effect.Effect<A, ApiError, R> => request("GET", url, schema, undefined, options);

export const post = <A, R>(
  url: string,
  body: unknown,
  schema: Schema.ConstraintDecoder<A, R>,
  options: RequestOptions = {},
): Effect.Effect<A, ApiError, R> => request("POST", url, schema, body, options);

export const put = <A, R>(
  url: string,
  body: unknown,
  schema: Schema.ConstraintDecoder<A, R>,
  options: RequestOptions = {},
): Effect.Effect<A, ApiError, R> => request("PUT", url, schema, body, options);

export const patch = <A, R>(
  url: string,
  body: unknown,
  schema: Schema.ConstraintDecoder<A, R>,
  options: RequestOptions = {},
): Effect.Effect<A, ApiError, R> => request("PATCH", url, schema, body, options);

export const del = <A, R>(
  url: string,
  schema: Schema.ConstraintDecoder<A, R>,
  options: RequestOptions = {},
): Effect.Effect<A, ApiError, R> => request("DELETE", url, schema, undefined, options);
