// Runtime glue between the chat-composer DOM and the reactive QueueStore that
// drives <QueuePanel>. Pure JS so it can be unit-tested without Svelte.
//
//   - Steer: the message is sent immediately to /api/chat. Because the worker
//     is already running, the server tags the prompt streamingBehavior:"steer"
//     so pi folds it into the active turn. The steer row in the panel is
//     browser-local and disappears either when the user dismisses it or when
//     the run completes.
//   - Queue: enqueueing goes through POST /api/chat/queue; the autonomous
//     server-side drainer dispatches items to the worker when it becomes idle
//     (or via a kick from the queue API). The browser is just a viewer onto
//     the server-side queue, kept in sync by SSE 'queue' events.
//   - sendNow / edit: both pull a queued row out of the server queue (DELETE)
//     before acting on it locally — send via /api/chat (sendNow) or put back
//     into the textarea (edit). That way the server doesn't try to dispatch
//     a row we've already taken over.
//
// `activeRun` is seeded and reconciled by authoritative worker-status events,
// then updated immediately by message-sent / worker-done events. A composer
// opened mid-run therefore recognises its first message as a steer, while the
// first message of a new idle run is not mislabeled.
import type { SessionEntry } from "../../../session/data/session-types";
import { isUnknownRecord } from "../../../session/data/session-types";
import { Schema } from "effect";
import type { QueueDisplayItem, QueueStore } from "./queue-store.svelte";

interface SteerAttachments {
  files(): File[];
  composeMessage(typed: string): string;
  clear(): void;
}

interface SteerQueueOptions {
  readonly windowImpl?: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly store: QueueStore;
  readonly queueButton?: HTMLButtonElement | null;
  readonly textarea?: HTMLTextAreaElement | null;
  readonly attachments?: SteerAttachments;
  readonly sendChatMessage?: (message: string, files: File[]) => Promise<boolean>;
  readonly autoResizeTextarea?: () => void;
  readonly updateSendEnabled?: () => void;
  readonly queueApi?: {
    remove(position: number): Promise<{ readonly removed: boolean }>;
  } | null;
  readonly getLiveEntries?: (() => readonly SessionEntry[]) | null;
}

const MessageSentDetail = Schema.Struct({
  message: Schema.String,
  route: Schema.optionalKey(Schema.Literals(["send", "steer"])),
});
const isMessageSentDetail = Schema.is(MessageSentDetail);

export function setupSteerQueue({
  windowImpl = window,
  store,
  queueButton,
  textarea,
  attachments = { files: () => [], composeMessage: (typed: string) => typed, clear: () => {} },
  sendChatMessage = async () => false,
  autoResizeTextarea = () => {},
  updateSendEnabled = () => {},
  queueApi = null,
  getLiveEntries = null,
}: SteerQueueOptions) {
  let activeRun = false;
  let disposed = false;

  function hasContent() {
    const typed = textarea ? textarea.value.trim() : "";
    return typed.length > 0 || !!attachments.files?.().length;
  }

  function updateQueueEnabled() {
    if (queueButton) queueButton.disabled = !hasContent();
  }

  function enqueueFromComposer() {
    const typed = textarea ? textarea.value.trim() : "";
    const message = attachments.composeMessage(typed);
    const files = (attachments.files?.() || []).slice();
    if (!message && files.length === 0) return false;
    // Clear the composer synchronously so a rapid second queue click can read
    // fresh content from the textarea before our POST round-trips. The store
    // mutation lands later when api.add resolves.
    if (textarea) textarea.value = "";
    attachments.clear?.();
    autoResizeTextarea();
    updateSendEnabled();
    updateQueueEnabled();
    if (textarea && typeof textarea.focus === "function") textarea.focus();
    void store.enqueueQueued({ message, displayText: typed });
    return true;
  }

  // Resolves whether it's safe to act on a queued row locally after pulling
  // it from the server queue. Returns false when the row is gone for a
  // reason OTHER than us just having removed it (server-side drainer already
  // claimed it, or the delete failed) — in that case the caller must not
  // dispatch/edit locally, or it races the drainer into double-dispatching
  // the same message. store.removeById() drops the now-stale local row so
  // the panel doesn't keep showing an item the server no longer has.
  function claimQueuedRow(
    focused: Extract<QueueDisplayItem, { kind: "queued" }>,
  ): Promise<boolean> {
    if (!queueApi || !Number.isInteger(focused.position)) return Promise.resolve(true);
    return queueApi.remove(focused.position).then(
      (result) => {
        if (result.removed) return true;
        store.removeById(focused.id);
        return false;
      },
      // Request failed outright (network/server error): treat as unclaimed
      // rather than risk a double-dispatch against a row we're not sure we own.
      () => false,
    );
  }

  async function sendNow(id: string): Promise<void> {
    const focused = store.items.find((it) => it.id === id);
    if (!focused || focused.kind !== "queued") return;
    // Pull from the server first so the drainer doesn't race us.
    if (!(await claimQueuedRow(focused))) return;
    store.takeLocalById(id);
    void sendChatMessage(focused.text, focused.files ? [...focused.files] : []);
  }

  async function edit(id: string): Promise<void> {
    const focused = store.items.find((it) => it.id === id);
    if (!focused || focused.kind !== "queued") return;
    if (!(await claimQueuedRow(focused))) return;
    store.takeLocalById(id);
    if (textarea) {
      textarea.value = focused.displayText || focused.text || "";
      autoResizeTextarea();
      updateSendEnabled();
      updateQueueEnabled();
      if (typeof textarea.focus === "function") textarea.focus();
    }
  }

  async function resume(): Promise<void> {
    await store.setPaused(false);
    // The server-side drainer kicks itself on PATCH, so no client-side
    // dispatch is needed.
  }

  const onMessageSent = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const message = isMessageSentDetail(detail) ? detail.message : "";
    const route = isMessageSentDetail(detail) ? detail.route : undefined;
    if (route === "steer" || (route === undefined && activeRun)) {
      store.pushSteer({ text: message });
    }
    activeRun = true;
  };

  const onWorkerDone = () => {
    activeRun = false;
    store.clearSteers();
    // Server drainer dispatches the next queued message; SSE 'queue' event
    // will refresh the panel so the head item disappears from the list.
  };

  const onWorkerStatus = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isUnknownRecord(detail) || typeof detail.state !== "string") return;
    if (detail.state === "running") activeRun = true;
    if (detail.state === "idle") onWorkerDone();
  };

  // When pi folds a steer into the active turn it appends a user entry to the
  // session JSONL. The live reload fires `pi-session-reload`; we then drop the
  // matching steer chip so it disappears as soon as the steer is observably
  // picked up, instead of waiting until the whole run completes.
  //
  // Strategy: first try a text match (most precise). If we can't match by
  // text — pi could decorate the stored content in ways we don't recognise —
  // fall back to a FIFO clear keyed on "did the count of user messages grow
  // since the previous reload?". Either path is safe because steer chips are
  // only ever added while `activeRun` is true; the next run begins via
  // pi-worker-done's clearSteers().
  function extractUserText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "string"
            ? part
            : isUnknownRecord(part) && typeof part.text === "string"
              ? part.text
              : "",
        )
        .join("");
    }
    return "";
  }

  function countUserMessages(entries: readonly SessionEntry[]): number {
    let n = 0;
    for (const entry of entries) {
      if (entry?.type === "message" && entry.message?.role === "user") n += 1;
    }
    return n;
  }

  // Seed at attach time with the current historical user-message count so we
  // don't treat existing entries as fresh steer pickups on the first reload.
  let lastUserMessageCount = getLiveEntries ? countUserMessages(getLiveEntries() || []) : 0;

  function reconcileSteersAgainstEntries() {
    if (!getLiveEntries) return;
    const entries = getLiveEntries() || [];
    const userCount = countUserMessages(entries);
    if (store.steerCount === 0) {
      lastUserMessageCount = userCount;
      return;
    }
    let newUserMessages = Math.max(0, userCount - lastUserMessageCount);
    lastUserMessageCount = userCount;

    // 1) Precise text match.
    if (newUserMessages > 0) {
      const recent = new Set();
      let scanned = 0;
      for (let i = entries.length - 1; i >= 0 && scanned < 25; i -= 1) {
        const entry = entries[i];
        if (!entry || entry.type !== "message") continue;
        if (entry.message?.role !== "user") continue;
        const text = extractUserText(entry.message.content).trim();
        if (text) recent.add(text);
        scanned += 1;
      }
      const matched = store.items.filter(
        (item) => item.kind === "steer" && recent.has(String(item.text || "").trim()),
      );
      for (const item of matched) {
        store.removeById(item.id);
        newUserMessages -= 1;
        if (newUserMessages <= 0) return;
      }
    }

    // 2) FIFO fallback. If pi's stored content doesn't match our captured chip
    // text exactly (decorated user entries, etc.) we still pop one steer chip
    // per newly arrived user message, oldest first.
    while (newUserMessages > 0 && store.steerCount > 0) {
      const head = store.items.find((item) => item.kind === "steer");
      if (!head) break;
      store.removeById(head.id);
      newUserMessages -= 1;
    }
  }

  store.actions.sendNow = sendNow;
  store.actions.edit = edit;
  store.actions.resume = resume;

  queueButton?.addEventListener("click", enqueueFromComposer);
  textarea?.addEventListener("input", updateQueueEnabled);
  windowImpl.addEventListener("pi-chat-message-sent", onMessageSent);
  windowImpl.addEventListener("pi-worker-done", onWorkerDone);
  windowImpl.addEventListener("pi-worker-status", onWorkerStatus);
  windowImpl.addEventListener("pi-session-reload", reconcileSteersAgainstEntries);

  updateQueueEnabled();

  return {
    enqueueFromComposer,
    sendNow,
    edit,
    resume,
    queuedCount: () => store.queuedCount,
    steerCount: () => store.steerCount,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      queueButton?.removeEventListener("click", enqueueFromComposer);
      textarea?.removeEventListener("input", updateQueueEnabled);
      windowImpl.removeEventListener("pi-chat-message-sent", onMessageSent);
      windowImpl.removeEventListener("pi-worker-done", onWorkerDone);
      windowImpl.removeEventListener("pi-worker-status", onWorkerStatus);
      windowImpl.removeEventListener("pi-session-reload", reconcileSteersAgainstEntries);
      if (store.actions.sendNow === sendNow) store.actions.sendNow = () => undefined;
      if (store.actions.edit === edit) store.actions.edit = () => undefined;
      if (store.actions.resume === resume) store.actions.resume = () => undefined;
    },
  };
}
