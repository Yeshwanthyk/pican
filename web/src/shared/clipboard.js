// Write text to the clipboard, falling back to a hidden textarea + execCommand
// for insecure (HTTP) contexts where navigator.clipboard is unavailable.
// Returns true when the copy succeeded. DOM seams are injectable for tests.
export async function copyToClipboard(
  text,
  { documentImpl = document, navigatorImpl = navigator } = {},
) {
  try {
    if (navigatorImpl.clipboard && navigatorImpl.clipboard.writeText) {
      await navigatorImpl.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = documentImpl.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    documentImpl.body.appendChild(ta);
    ta.select();
    const ok = documentImpl.execCommand('copy');
    documentImpl.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
