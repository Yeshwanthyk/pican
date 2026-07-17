import { t } from '../../../shared/i18n.js';
import { copyToClipboard } from '../../../shared/clipboard.js';

export function showCwdToast(
  { documentImpl = document, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {},
  message,
  isError = false,
) {
  const composer = documentImpl.getElementById('pi-chat-composer');
  if (!composer) return;
  let notice = documentImpl.getElementById('pi-chat-cwd-toast');
  if (!notice) {
    notice = documentImpl.createElement('div');
    notice.id = 'pi-chat-cwd-toast';
    notice.style.cssText =
      'position:fixed;top:60px;right:8px;z-index:200;padding:2px 8px;font-size:10px;font-family:inherit;background:var(--accent);color:var(--body-bg);border-radius:3px;opacity:0;transition:opacity 0.3s;pointer-events:none;';
    documentImpl.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.style.background = isError ? 'var(--error)' : 'var(--accent)';
  notice.style.opacity = '1';
  clearTimeoutImpl(notice._hideTimer);
  notice._hideTimer = setTimeoutImpl(() => {
    notice.style.opacity = '0';
    setTimeoutImpl(() => {
      if (notice.parentNode) notice.parentNode.removeChild(notice);
    }, 300);
  }, 1200);
}

export function setupCwdCopy({
  documentImpl = document,
  windowImpl = window,
  tImpl = t,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const cwdEl = documentImpl.querySelector('.pi-chat-cwd');
  if (!cwdEl) return;
  cwdEl.addEventListener('click', async () => {
    const path = cwdEl.dataset.cwd || cwdEl.textContent.replace(/^cwd:\s*/, '');
    const ok = await copyToClipboard(path, {
      documentImpl,
      navigatorImpl: windowImpl.navigator,
    });
    if (ok) {
      showCwdToast(
        { documentImpl, setTimeoutImpl, clearTimeoutImpl },
        tImpl('composer.pathCopied'),
      );
    } else {
      showCwdToast(
        { documentImpl, setTimeoutImpl, clearTimeoutImpl },
        tImpl('common.copyFailed'),
        true,
      );
    }
  });
}
