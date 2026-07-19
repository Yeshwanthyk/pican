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
  const searchInput =
    InputElement && searchElement instanceof InputElement ? searchElement : null;
  searchInput?.addEventListener("input", (e) => {
    if (e.currentTarget !== searchInput) return;
    setSearchQuery(searchInput.value);
    forceTreeRerender();
  });

  documentImpl.querySelectorAll<HTMLElement>(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      documentImpl.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setFilterMode(btn.dataset.filter ?? "default");
      forceTreeRerender();
    });
  });

  return {
    clearAndNavigateBottom() {
      const hasQuery = searchInput && searchInput.value;
      if (searchInput) searchInput.value = "";
      setSearchQuery("");
      if (hasQuery) {
        navigateTo(getLeafId(), "bottom");
      }
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
  return (
    (element instanceof HTMLElement && element.isContentEditable) ||
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
}): void {
  documentImpl.addEventListener("keydown", (e) => {
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
  });
}
