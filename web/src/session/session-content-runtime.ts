// Live wiring for the message pane (#messages). <SessionContent> renders
// model.activePath as <SessionEntry> components and runs afterRender(container)
// after each (re)render; this supplies that afterRender hook (toggle state +
// lazy highlight), the per-message copy/fork/label delegated handler, and the
// download-JSONL action. Also builds the sessionFormat object setupSessionUi
// needs. Live-only — the static export wires its own afterRender in export-entry.

import { Effect } from "effect";
import { NetworkError, describeError } from "../lib/errors";
import { runFork, runPromise } from "../lib/runtime";
import { setIconElement, Loader } from "../shared/icons.js";
import { t } from "../shared/strings.js";
import { openDiff, openLabel } from "./session-modals.svelte.js";
import { navigate } from "../shared/navigation.js";
import { sessionRuntime } from "./session-runtime.js";
import { extractContent } from "./tree/session-filter.js";
import {
  escapeHtml,
  formatToolCall,
  getTreeNodeDisplayHtml,
  shortenPath,
  truncate,
} from "./render/session-format.js";
import {
  buildShareUrl,
  copyToClipboard,
  downloadSessionJson,
} from "./render/session-entry-actions.js";
import { forkSession, labelSession } from "./session-menu-actions.js";
import type { SessionEntry, ToolCallInfo, UnknownRecord } from "./data/session-types.js";

declare global {
  interface Window {
    downloadSessionJson?: () => void;
  }
}

interface SessionContentModel {
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly header: UnknownRecord | null;
  readonly toolCallMap: ReadonlyMap<string, ToolCallInfo>;
  readonly labelMap: Map<string, string>;
  readonly currentLeafId?: string;
}

interface ContentRuntime {
  afterRender: ((container: HTMLElement) => void) | null;
}

interface WireSessionContentOptions {
  readonly windowImpl: Window;
  readonly documentImpl: Document;
  readonly model: SessionContentModel;
  readonly sessionId?: string;
  readonly contentRuntime?: ContentRuntime | null;
  readonly applyLazyHighlighting: (documentImpl: Document) => void;
}

export function wireSessionContentRuntime({
  windowImpl,
  documentImpl,
  model,
  sessionId = "",
  contentRuntime,
  applyLazyHighlighting,
}: WireSessionContentOptions) {
  const target = windowImpl;

  const escape = (text: unknown) => escapeHtml(text, { documentImpl });
  const sessionFormat = {
    shortenPath,
    formatToolCall,
    escapeHtml: escape,
    truncate,
    getTreeNodeDisplayHtml: (entry: SessionEntry, label?: string) =>
      getTreeNodeDisplayHtml(entry, label, {
        extractContent,
        toolCallMap: model.toolCallMap,
        escapeHtmlImpl: escape,
      }),
  };

  const previousDownloadSessionJson = target.downloadSessionJson;
  target.downloadSessionJson = () =>
    downloadSessionJson({
      entries: model.entries,
      header: model.header,
      documentImpl,
      URLImpl: globalThis.URL,
      BlobImpl: globalThis.Blob,
    });

  // Fork a new session starting at an entry.
  const forkEntry = (entryId: string, btn: HTMLButtonElement): void => {
    if (
      !target.confirm("Are you sure you want to fork a new session starting from this message?")
    ) {
      return;
    }
    const originalChildren = Array.from(btn.childNodes).map((node) => node.cloneNode(true));
    const restoreButton = () =>
      btn.replaceChildren(...originalChildren.map((node) => node.cloneNode(true)));
    setIconElement(btn, Loader, { size: 13, class: "spinner", documentImpl });
    btn.disabled = true;

    const operation = Effect.tryPromise({
      try: () => forkSession(sessionId, entryId, { fetchImpl: target.fetch.bind(target) }),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(
      Effect.match({
        onFailure: () => {
          restoreButton();
          btn.disabled = false;
          target.alert("Fork failed");
        },
        onSuccess: (data) => {
          const id = data.id;
          if (typeof id === "string" && id) {
            navigate("/session?id=" + encodeURIComponent(id), { windowImpl: target });
            return;
          }
          restoreButton();
          btn.disabled = false;
          const notice = documentImpl.getElementById("command-menu-toast");
          if (notice) {
            notice.textContent = "Fork failed";
            notice.classList.add("visible");
            setTimeout(() => notice.classList.remove("visible"), 1500);
          } else {
            target.alert("Fork failed");
          }
        },
      }),
    );
    runFork(operation);
  };

  // Set/clear an entry's tree label. The modal is <LabelModal>, opened via the
  // shared sessionModals store; this owns the save (API + reactive labelMap update).
  const labelEntry = (entryId: string): void => {
    openLabel({
      entryId,
      currentLabel: model.labelMap.get(entryId) || "",
      onSave: ({ entryId: id, label }) =>
        runPromise(
          Effect.tryPromise({
            try: () => labelSession(sessionId, id, label, { fetchImpl: target.fetch.bind(target) }),
            catch: (cause) => new NetworkError({ cause }),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (label) model.labelMap.set(id, label);
                else model.labelMap.delete(id);
              }),
            ),
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.sync(() => target.alert(describeError(error) || t("session.labelSaveFailed"))),
            ),
          ),
        ),
    });
  };

  // After each (re)render of <SessionContent>, re-apply persisted collapse/toggle
  // state and lazy-highlight any pending code blocks.
  if (contentRuntime) {
    contentRuntime.afterRender = (container: HTMLElement) => {
      sessionRuntime.toggleState?.applyToNode(container);
      applyLazyHighlighting(documentImpl);
    };
  }

  // One delegated handler for the per-entry copy/fork/label buttons; survives the
  // reactive re-renders of #messages.
  const messagesEl = documentImpl.getElementById("messages");
  const onMessagesClick = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    const fullDiffBtn = e.target.closest<HTMLElement>(".open-full-diff-btn");
    if (fullDiffBtn?.dataset.sessionId) {
      e.stopPropagation();
      openDiff({ sessionId: fullDiffBtn.dataset.sessionId });
      return;
    }
    const copyBtn = e.target.closest<HTMLElement>(".copy-link-btn");
    if (copyBtn?.dataset.entryId) {
      e.stopPropagation();
      const url = buildShareUrl(copyBtn.dataset.entryId, {
        documentImpl,
        windowImpl: target,
        getCurrentLeafId: () => model.currentLeafId ?? "",
        URLImpl: globalThis.URL,
      });
      copyToClipboard(url, copyBtn, { documentImpl, navigatorImpl: target.navigator });
      return;
    }
    const forkBtn = e.target.closest<HTMLButtonElement>(".fork-btn");
    if (forkBtn && forkBtn.dataset.entryId) {
      e.stopPropagation();
      forkEntry(forkBtn.dataset.entryId, forkBtn);
      return;
    }
    const labelBtn = e.target.closest<HTMLElement>(".label-btn");
    if (labelBtn?.dataset.entryId) {
      e.stopPropagation();
      labelEntry(labelBtn.dataset.entryId);
    }
  };
  messagesEl?.addEventListener("click", onMessagesClick);

  return {
    sessionFormat,
    dispose: () => {
      messagesEl?.removeEventListener("click", onMessagesClick);
      if (previousDownloadSessionJson === undefined) delete target.downloadSessionJson;
      else target.downloadSessionJson = previousDownloadSessionJson;
    },
  };
}
