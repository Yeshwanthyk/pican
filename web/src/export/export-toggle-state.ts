interface ExportToggleState {
  thinkingExpanded: boolean;
  toolsVisible: boolean;
  toolOutputsExpanded: boolean;
}

type ToggleKey = keyof ExportToggleState;

const defaultState = (): ExportToggleState => ({
  thinkingExpanded: true,
  toolsVisible: true,
  toolOutputsExpanded: false,
});

function applyToggleState(node: ParentNode, state: ExportToggleState): void {
  node.querySelectorAll<HTMLElement>(".thinking-text").forEach((element) => {
    element.style.display = state.thinkingExpanded ? "" : "none";
  });
  node.querySelectorAll<HTMLElement>(".thinking-collapsed").forEach((element) => {
    element.style.display = state.thinkingExpanded ? "none" : "block";
  });
  node.querySelectorAll<HTMLElement>(".tool-execution, .compaction").forEach((element) => {
    element.style.display = state.toolsVisible ? "" : "none";
  });
  node.querySelectorAll<HTMLElement>(".tool-call-collapsed").forEach((element) => {
    element.style.display = state.toolsVisible ? "none" : "block";
  });
  node.querySelectorAll<HTMLElement>(".tool-output.expandable, .compaction").forEach((element) => {
    element.classList.toggle("expanded", state.toolOutputsExpanded);
  });
}

function syncButtons(documentImpl: Document, state: ExportToggleState): void {
  const buttons: ReadonlyArray<readonly [string, boolean]> = [
    ['[data-action="toggle-thinking"]', state.thinkingExpanded],
    ['[data-action="toggle-tools"]', state.toolsVisible],
    ['[data-action="toggle-tool-output"]', state.toolOutputsExpanded],
  ];
  for (const [selector, active] of buttons) {
    const button = documentImpl.querySelector<HTMLButtonElement>(selector);
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", active ? "true" : "false");
  }
  const outputButton = documentImpl.querySelector<HTMLButtonElement>(
    '[data-action="toggle-tool-output"]',
  );
  if (outputButton) outputButton.disabled = !state.toolsVisible;
}

export function createToggleController({
  documentImpl = document,
}: {
  readonly documentImpl?: Document;
  readonly storage?: unknown;
  readonly sessionId?: string;
} = {}) {
  const state = defaultState();
  const applyToNode = (node: ParentNode): void => applyToggleState(node, state);
  const sync = (): void => syncButtons(documentImpl, state);
  const toggle = (key: ToggleKey): void => {
    state[key] = !state[key];
    applyToNode(documentImpl);
    sync();
  };
  const toggleThinking = (): void => toggle("thinkingExpanded");
  const toggleToolsVisibility = (): void => toggle("toolsVisible");
  const toggleToolOutputs = (): void => {
    if (state.toolsVisible) toggle("toolOutputsExpanded");
  };
  return {
    state,
    applyToNode,
    syncButtons: sync,
    toggleThinking,
    toggleToolsVisibility,
    toggleToolOutputs,
    reload(): void {
      applyToNode(documentImpl);
      sync();
    },
    attachHeaderHandlers(): void {
      documentImpl
        .querySelector('[data-action="toggle-thinking"]')
        ?.addEventListener("click", toggleThinking);
      documentImpl
        .querySelector('[data-action="toggle-tools"]')
        ?.addEventListener("click", toggleToolsVisibility);
      documentImpl
        .querySelector('[data-action="toggle-tool-output"]')
        ?.addEventListener("click", toggleToolOutputs);
      sync();
    },
  };
}
