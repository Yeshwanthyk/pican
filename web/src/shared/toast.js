// Shared transient toast notice. Renders (or reuses) a `.toast-notice` element
// by id, shows it, and auto-hides it after `duration`. One timer per id so
// repeated toasts of the same kind reset cleanly without callers tracking state.

const timers = new Map();

export function showToast(message, options = {}) {
  const { id = 'app-toast', duration = 1500, title = '', documentImpl = document } = options;

  let notice = documentImpl.getElementById(id);
  if (!notice) {
    notice = documentImpl.createElement('div');
    notice.id = id;
    notice.className = 'toast-notice';
    documentImpl.body.appendChild(notice);
  }

  notice.textContent = message;
  if (title) notice.title = title;

  clearTimeout(timers.get(id));
  notice.classList.add('visible');
  timers.set(
    id,
    setTimeout(() => notice.classList.remove('visible'), duration),
  );

  return notice;
}
