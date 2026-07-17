export function extensionRequestExpiresAt(request) {
  const timeout = Number(request?.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return null;
  const receivedAt = Number(request?._receivedAt);
  return (Number.isFinite(receivedAt) ? receivedAt : Date.now()) + timeout;
}

export function isExtensionRequestExpired(request, now = Date.now()) {
  const expiresAt = extensionRequestExpiresAt(request);
  return expiresAt !== null && now >= expiresAt;
}

export function reducePendingExtensionUI(requests, action, now = Date.now()) {
  const current = (Array.isArray(requests) ? requests : []).filter(
    (request) => request?.id && !isExtensionRequestExpired(request, now),
  );
  if (action?.type === 'resolve') {
    return current.filter((request) => request.id !== action.id);
  }
  if (action?.type === 'timeout') {
    return current.filter((request) => request.id !== action.id);
  }
  if (action?.type !== 'add' || !action.request?.id) return current;
  const request = {
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
