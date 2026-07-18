export function sessionResumeCommand({ runtime = 'pi', nativeId = '', sessionUUID = '' } = {}) {
  if (runtime === 'codex') return nativeId ? `codex resume ${nativeId}` : '';
  return sessionUUID ? `pi --session ${sessionUUID}` : '';
}
