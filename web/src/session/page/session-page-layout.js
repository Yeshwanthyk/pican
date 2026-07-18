import { isMobileLayout } from '../ui/sidebar.js';

export function applySessionPageBodyClasses({ documentImpl = document } = {}) {
  documentImpl.documentElement.classList.add('pi-session-page');
  documentImpl.body.classList.add('pi-session-page');
  return () => {
    documentImpl.documentElement.classList.remove('pi-session-page');
    documentImpl.body.classList.remove('pi-session-page');
  };
}

export function applyStoredSessionLayout({
  documentImpl = document,
  windowImpl = window,
  storage = windowImpl?.localStorage,
} = {}) {
  if (!documentImpl || !storage) return;

  try {
    const collapsed = storage.getItem('pi-web:v1:right-sidebar-collapsed');
    const mobile = isMobileLayout({ windowImpl });
    if (collapsed === 'true' || mobile) {
      documentImpl.body.classList.add('right-sidebar-collapsed');
    }
  } catch {}

  try {
    const width = Number(storage.getItem('pi-web:v1:right-sidebar-width'));
    if (Number.isFinite(width) && width > 0) {
      documentImpl.documentElement.style.setProperty(
        '--right-sidebar-width',
        `${Math.round(width)}px`,
      );
    }
  } catch {}
}
