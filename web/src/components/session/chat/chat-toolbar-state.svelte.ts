export function isRunningStatus(text: string, cls: string): boolean {
  return (
    cls === "running" ||
    text === "running" ||
    text === "sending" ||
    text === "submitted" ||
    text === "queued" ||
    text === "accepted" ||
    text === "stopping"
  );
}

// Reactive toolbar state shared between the live runtime (chat-composer-runtime.js)
// and the declarative <ChatToolbar>. The runtime mutates these fields; the
// component reads them through bindings. Replaces the former imperative
// getElementById/textContent DOM mutation. Live-only.
export class ChatToolbarState {
  statusText = $state("");
  statusClass = $state("");
  modelLabel = $state("");
  thinkingLevel = $state("");
  knownModelLabel = $state("");
  knownThinkingLevel = $state("");

  // Injected by the runtime once the context-usage controller exists.
  updateContextUsage: () => void = () => undefined;

  isRunning = $derived(isRunningStatus(this.statusText, this.statusClass));

  setStatus = (text: string, cls = ""): void => {
    this.statusText = text;
    this.statusClass = cls;
  };

  setModelLabel = (label: string): void => {
    if (label) this.modelLabel = label;
    this.updateContextUsage();
  };

  setThinkingLabel = (level: string): void => {
    this.thinkingLevel = level || "";
  };

  getKnownModelLabel = (): string => this.knownModelLabel;
  setKnownModelLabel = (label: string): void => {
    this.knownModelLabel = label;
  };
  getKnownThinkingLevel = (): string => this.knownThinkingLevel;
  setKnownThinkingLevel = (level: string): void => {
    this.knownThinkingLevel = level;
  };
}
