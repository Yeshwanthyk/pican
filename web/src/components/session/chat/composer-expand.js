export function setupComposerExpansion({
  sessionId = '',
  shell,
  expandButton,
  textarea,
  storage,
  onHeightChange = () => {},
} = {}) {
  const storageKey = 'pi-chat:composer-expanded:' + (sessionId || 'default');

  function apply(expanded) {
    if (!shell) return;
    shell.classList.toggle('expanded', !!expanded);
    if (expandButton) {
      const label = expanded ? 'Collapse composer' : 'Expand composer';
      expandButton.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      expandButton.setAttribute('aria-label', label);
      expandButton.title = label;
    }
    onHeightChange();
  }

  let initialExpanded = false;
  try {
    initialExpanded = storage && storage.getItem(storageKey) === '1';
  } catch {
    // Storage may be unavailable in private browsing or tests.
  }
  apply(initialExpanded);

  expandButton?.addEventListener('click', () => {
    const willExpand = !shell?.classList.contains('expanded');
    apply(willExpand);
    try {
      storage?.setItem(storageKey, willExpand ? '1' : '0');
    } catch {
      // Ignore storage availability errors; expansion still works for this page.
    }
    if (willExpand && textarea && typeof textarea.focus === 'function') textarea.focus();
  });

  return { apply, storageKey };
}
