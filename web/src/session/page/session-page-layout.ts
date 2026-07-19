import { Effect } from "effect";
import { StorageError } from "../../lib/errors";
import { runSync } from "../../lib/runtime";
import { isMobileLayout } from "../ui/sidebar.js";

interface LayoutStorage {
  getItem(key: string): string | null;
}

interface LayoutWindow {
  readonly localStorage?: LayoutStorage;
  matchMedia?(query: string): { readonly matches: boolean };
}

const readStorage = (storage: LayoutStorage, key: string): string | null =>
  runSync(
    Effect.try({
      try: () => storage.getItem(key),
      catch: (cause) => new StorageError({ key, op: "read", cause }),
    }).pipe(
      Effect.catch(() => Effect.succeed(null)),
    ),
  );

export function applySessionPageBodyClasses({
  documentImpl = document,
}: { readonly documentImpl?: Document } = {}): () => void {
  documentImpl.documentElement.classList.add("pican-session-page");
  documentImpl.body.classList.add("pican-session-page");
  return () => {
    documentImpl.documentElement.classList.remove("pican-session-page");
    documentImpl.body.classList.remove("pican-session-page");
  };
}

export function applyStoredSessionLayout({
  documentImpl = document,
  windowImpl = globalThis.window,
  storage = windowImpl?.localStorage,
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: LayoutWindow;
  readonly storage?: LayoutStorage;
} = {}): void {
  if (!documentImpl || !storage) return;

  const collapsed = readStorage(storage, "pican:v1:right-sidebar-collapsed");
  const mobile = isMobileLayout({ windowImpl });
  if (collapsed === "true" || mobile) {
    documentImpl.body.classList.add("right-sidebar-collapsed");
  }

  const width = Number(readStorage(storage, "pican:v1:right-sidebar-width"));
  if (Number.isFinite(width) && width > 0) {
    documentImpl.documentElement.style.setProperty(
      "--right-sidebar-width",
      `${Math.round(width)}px`,
    );
  }
}
