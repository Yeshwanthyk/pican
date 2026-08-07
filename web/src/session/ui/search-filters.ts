type NavigateTo = (
  targetId: string,
  scrollMode?: "target" | "bottom" | "none",
  scrollToEntryId?: string | null,
) => void;

interface SearchFilterOptions {
  readonly documentImpl?: Document;
  readonly getLeafId: () => string;
  readonly setSearchQuery: (value: string) => void;
  readonly setFilterMode: (value: string) => void;
  readonly forceTreeRerender: () => void;
  readonly navigateTo: NavigateTo;
}

export function setupSessionSearchAndFilters({
  documentImpl = document,
  getLeafId,
  setSearchQuery,
  setFilterMode,
  forceTreeRerender,
  navigateTo,
}: SearchFilterOptions) {
  const searchElement = documentImpl.getElementById("tree-search");
  const InputElement = documentImpl.defaultView?.HTMLInputElement;
  const searchInput = InputElement && searchElement instanceof InputElement ? searchElement : null;
  const onSearchInput = (event: Event) => {
    if (event.currentTarget !== searchInput || !searchInput) return;
    setSearchQuery(searchInput.value);
    forceTreeRerender();
  };
  searchInput?.addEventListener("input", onSearchInput);

  const filterHandlers = new Map<HTMLElement, () => void>();
  documentImpl.querySelectorAll<HTMLElement>(".filter-btn").forEach((button) => {
    const onClick = () => {
      documentImpl.querySelectorAll(".filter-btn").forEach((candidate) => {
        candidate.classList.remove("active");
      });
      button.classList.add("active");
      setFilterMode(button.dataset.filter ?? "default");
      forceTreeRerender();
    };
    filterHandlers.set(button, onClick);
    button.addEventListener("click", onClick);
  });

  return {
    clearAndNavigateBottom() {
      const hasQuery = searchInput && searchInput.value;
      if (searchInput) searchInput.value = "";
      setSearchQuery("");
      if (hasQuery) navigateTo(getLeafId(), "bottom");
    },
    dispose() {
      searchInput?.removeEventListener("input", onSearchInput);
      filterHandlers.forEach((handler, button) => button.removeEventListener("click", handler));
      filterHandlers.clear();
    },
  };
}

export function isEditableTarget(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tagName = element.tagName;
  if (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    tagName === "BUTTON"
  ) {
    return true;
  }
  const HTMLElementCtor = element.ownerDocument.defaultView?.HTMLElement;
  return (
    Boolean(HTMLElementCtor && element instanceof HTMLElementCtor && element.isContentEditable) ||
    Boolean(element.closest?.('[contenteditable="true"]'))
  );
}

export function setupSessionKeyboardShortcuts({
  documentImpl = document,
  clearSearch,
  toggleThinking,
  toggleToolsVisibility,
  toggleToolOutputs,
  isEditableTargetImpl = isEditableTarget,
}: {
  readonly documentImpl?: Document;
  readonly clearSearch: () => void;
  readonly toggleThinking: () => void;
  readonly toggleToolsVisibility: () => void;
  readonly toggleToolOutputs: () => void;
  readonly isEditableTargetImpl?: (element: Element | null) => boolean;
}): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const active = documentImpl.activeElement;
      if (isEditableTargetImpl(active) && active !== documentImpl.getElementById("tree-search")) {
        return;
      }
      clearSearch();
    }

    if (isEditableTargetImpl(documentImpl.activeElement)) {
      return;
    }

    const key = e.key.toLowerCase();
    if (key === "t") {
      e.preventDefault();
      toggleThinking();
    } else if (key === "o") {
      e.preventDefault();
      toggleToolsVisibility();
    } else if (key === "p") {
      e.preventDefault();
      toggleToolOutputs();
    }
  };
  documentImpl.addEventListener("keydown", onKeyDown);
  return () => documentImpl.removeEventListener("keydown", onKeyDown);
}
