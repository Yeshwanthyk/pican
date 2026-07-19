// Shared transient toast notice. Renders (or reuses) a `.toast-notice` element
// by id, shows it, and auto-hides it after `duration`. One timer per id so
// repeated toasts of the same kind reset cleanly without callers tracking state.

interface ToastElement {
  id: string;
  className: string;
  textContent: string | null;
  title: string;
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
}

interface ToastDocument {
  readonly body: { appendChild(element: ToastElement): void };
  getElementById(id: string): ToastElement | null;
  createElement(tag: "div"): ToastElement;
}

interface ToastOptions {
  readonly id?: string;
  readonly duration?: number;
  readonly title?: string;
  readonly documentImpl?: ToastDocument;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

const browserToastDocument: ToastDocument = {
  body: { appendChild: (element) => document.body.appendChild(element as HTMLElement) },
  getElementById: (id) => document.getElementById(id),
  createElement: () => document.createElement("div"),
};

export function showToast(message: string, options: ToastOptions = {}): ToastElement {
  const {
    id = "app-toast",
    duration = 1500,
    title = "",
    documentImpl = browserToastDocument,
  } = options;

  let notice = documentImpl.getElementById(id);
  if (!notice) {
    notice = documentImpl.createElement("div");
    notice.id = id;
    notice.className = "toast-notice";
    documentImpl.body.appendChild(notice);
  }

  notice.textContent = message;
  if (title) notice.title = title;

  const previous = timers.get(id);
  if (previous !== undefined) clearTimeout(previous);
  notice.classList.add("visible");
  timers.set(
    id,
    setTimeout(() => notice.classList.remove("visible"), duration),
  );

  return notice;
}
