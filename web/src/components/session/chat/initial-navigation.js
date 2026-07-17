export function navigateInitialChatLeaf({
  entries = [],
  leafId = '',
  urlTargetId = '',
  byId = new Map(),
  navigateTo = () => {},
} = {}) {
  if (leafId) {
    if (urlTargetId && byId.has(urlTargetId)) {
      navigateTo(leafId, 'target', urlTargetId);
    } else {
      navigateTo(leafId, 'none');
    }
    return;
  }

  if (entries.length > 0) {
    navigateTo(entries[entries.length - 1].id, 'none');
  }
}
