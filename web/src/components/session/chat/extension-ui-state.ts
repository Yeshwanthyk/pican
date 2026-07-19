export interface ExtensionRequest {
  readonly id: string;
  readonly method?: "select" | "confirm" | "input" | "editor";
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly timeout?: number;
  readonly _receivedAt?: number;
}

export type ExtensionUiAction =
  | { readonly type: "add"; readonly request: ExtensionRequest }
  | { readonly type: "resolve" | "timeout"; readonly id: string }
  | { readonly type: "prune" };

export function extensionRequestExpiresAt(request: ExtensionRequest): number | null {
  const timeout = Number(request.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return null;
  const receivedAt = Number(request._receivedAt);
  return (Number.isFinite(receivedAt) ? receivedAt : Date.now()) + timeout;
}

export function isExtensionRequestExpired(request: ExtensionRequest, now = Date.now()): boolean {
  const expiresAt = extensionRequestExpiresAt(request);
  return expiresAt !== null && now >= expiresAt;
}

export function reducePendingExtensionUI(
  requests: readonly ExtensionRequest[],
  action: ExtensionUiAction,
  now = Date.now(),
): ExtensionRequest[] {
  const current = requests.filter(
    (request) => request.id && !isExtensionRequestExpired(request, now),
  );
  if (action.type !== "add") {
    if (action.type === "prune") return current;
    return current.filter((request) => request.id !== action.id);
  }
  const request: ExtensionRequest = {
    ...action.request,
    _receivedAt: Number.isFinite(Number(action.request._receivedAt))
      ? Number(action.request._receivedAt)
      : now,
  };
  if (isExtensionRequestExpired(request, now)) return current;
  const existing = current.findIndex((item) => item.id === request.id);
  if (existing < 0) return [...current, request];
  return current.map((item, index) => (index === existing ? request : item));
}
