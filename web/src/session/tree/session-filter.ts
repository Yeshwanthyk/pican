import type { FlatTreeNode, TreeEntry, TreeGutter } from "./session-tree.js";
import { contentBlocksFromUnknown } from "../data/session-types.js";

export function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return contentBlocksFromUnknown(content).some(
    (block) => block.type === "text" && Boolean(block.text?.trim()),
  );
}

export function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocksFromUnknown(content)
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("");
}

export function getSearchableText(entry: TreeEntry, label?: string): string {
  const parts: string[] = [];
  if (label) parts.push(label);

  if (entry.type === "message") {
    const msg = entry.message;
    if (!msg) return parts.join(" ").toLowerCase();
    if (msg.role) parts.push(msg.role);
    if (msg.content) parts.push(extractContent(msg.content));
    if (msg.role === "bashExecution" && msg.command) parts.push(msg.command);
  } else if (entry.type === "custom_message") {
    if (entry.customType) parts.push(entry.customType);
    parts.push(typeof entry.content === "string" ? entry.content : extractContent(entry.content));
  } else if (entry.type === "compaction") {
    parts.push("compaction");
  } else if (entry.type === "branch_summary") {
    parts.push("branch summary", entry.summary ?? "");
  } else if (entry.type === "model_change") {
    parts.push("model", entry.modelId ?? "");
  } else if (entry.type === "thinking_level_change") {
    parts.push("thinking", entry.thinkingLevel ?? "");
  }

  return parts.join(" ").toLowerCase();
}

type FilterStackEntry = readonly [string, number, boolean, boolean, boolean, TreeGutter[], boolean];

export function recalculateVisualStructure(
  filteredNodes: FlatTreeNode[],
  allFlatNodes: ReadonlyArray<FlatTreeNode>,
): void {
  if (filteredNodes.length === 0) return;

  const visibleIds = new Set<string>(filteredNodes.map((n) => n.node.entry.id));
  const entryMap = new Map<string, FlatTreeNode>();
  for (const flatNode of allFlatNodes) entryMap.set(flatNode.node.entry.id, flatNode);

  function findVisibleAncestor(nodeId: string): string | null {
    let currentId = entryMap.get(nodeId)?.node.entry.parentId;
    while (currentId != null) {
      if (visibleIds.has(currentId)) return currentId;
      currentId = entryMap.get(currentId)?.node.entry.parentId;
    }
    return null;
  }

  const visibleChildren = new Map<string | null, string[]>([[null, []]]);
  for (const flatNode of filteredNodes) {
    const nodeId = flatNode.node.entry.id;
    const ancestorId = findVisibleAncestor(nodeId);
    if (!visibleChildren.has(ancestorId)) visibleChildren.set(ancestorId, []);
    const siblings = visibleChildren.get(ancestorId);
    if (siblings && !siblings.includes(nodeId)) siblings.push(nodeId);
  }

  const visibleRootIds = visibleChildren.get(null) ?? [];
  const multipleRoots = visibleRootIds.length > 1;
  const filteredNodeMap = new Map(
    filteredNodes.map((flatNode) => [flatNode.node.entry.id, flatNode]),
  );
  const stack: FilterStackEntry[] = [];

  for (let i = visibleRootIds.length - 1; i >= 0; i -= 1) {
    const isLast = i === visibleRootIds.length - 1;
    const rootId = visibleRootIds[i];
    if (!rootId) continue;
    stack.push([
      rootId,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      isLast,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;
    const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = next;
    const flatNode = filteredNodeMap.get(nodeId);
    if (!flatNode) continue;

    flatNode.indent = indent;
    flatNode.showConnector = showConnector;
    flatNode.isLast = isLast;
    flatNode.gutters = gutters;
    flatNode.isVirtualRootChild = isVirtualRootChild;
    flatNode.multipleRoots = multipleRoots;

    const children = visibleChildren.get(nodeId) || [];
    const multipleChildren = children.length > 1;
    let childIndent;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    for (let i = children.length - 1; i >= 0; i -= 1) {
      const childIsLast = i === children.length - 1;
      const childId = children[i];
      if (!childId) continue;
      stack.push([
        childId,
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }
}

export function filterNodes(
  flatNodes: FlatTreeNode[],
  currentLeafId: string,
  {
    filterMode = "default",
    searchQuery = "",
  }: {
    readonly filterMode?: "default" | "user-only" | "no-tools" | "labeled-only" | "all";
    readonly searchQuery?: string;
  } = {},
): FlatTreeNode[] {
  const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

  const filtered = flatNodes.filter((flatNode) => {
    const entry = flatNode.node.entry;
    const label = flatNode.node.label;
    if (entry.id === currentLeafId) return true;

    if (entry.type === "message" && entry.message?.role === "assistant") {
      const msg = entry.message;
      const hasText = hasTextContent(msg.content);
      const isErrorOrAborted =
        msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
      if (!hasText && !isErrorOrAborted) return false;
    }

    const isSettingsEntry = ["label", "custom", "model_change", "thinking_level_change"].includes(
      entry.type ?? "",
    );
    const passesFilter =
      filterMode === "user-only"
        ? entry.type === "message" && entry.message?.role === "user"
        : filterMode === "no-tools"
          ? !isSettingsEntry && !(entry.type === "message" && entry.message?.role === "toolResult")
          : filterMode === "labeled-only"
            ? label !== undefined
            : filterMode === "all"
              ? true
              : !isSettingsEntry;
    if (!passesFilter) return false;

    if (searchTokens.length > 0) {
      const nodeText = getSearchableText(entry, label);
      if (!searchTokens.every((t) => nodeText.includes(t))) return false;
    }
    return true;
  });

  recalculateVisualStructure(filtered, flatNodes);
  return filtered;
}
