interface SessionResumeOptions {
  readonly runtime?: string;
  readonly nativeId?: string;
  readonly sessionUUID?: string;
}

export function sessionResumeCommand({
  runtime = "pi",
  nativeId = "",
  sessionUUID = "",
}: SessionResumeOptions = {}): string {
  if (runtime === "codex") return nativeId ? `codex resume ${nativeId}` : "";
  return sessionUUID ? `pi --session ${sessionUUID}` : "";
}
