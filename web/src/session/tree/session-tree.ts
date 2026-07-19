export interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface TreeEntry {
  readonly id: string;
  readonly parentId?: string | null;
  readonly type?: string;
  readonly timestamp?: string | number | Date;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | ReadonlyArray<ContentBlock>;
    readonly command?: string;
    readonly stopReason?: string;
  };
  readonly content?: string | ReadonlyArray<ContentBlock>;
  readonly customType?: string;
  readonly summary?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly [key: string]: unknown;
}

export interface TreeNode {
  readonly entry: TreeEntry;
  readonly children: TreeNode[];
  readonly label?: string;
}

export interface TreeGutter {
  readonly position: number;
  readonly show: boolean;
}

export interface FlatTreeNode {
  readonly node: TreeNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: TreeGutter[];
  isVirtualRootChild: boolean;
  multipleRoots: boolean;
}

type FlattenStackEntry = readonly [
  TreeNode,
  number,
  boolean,
  boolean,
  boolean,
  TreeGutter[],
  boolean,
];

export function buildTree(
  entries: ReadonlyArray<TreeEntry> = [],
  labelMap: ReadonlyMap<string, string> = new Map(),
): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Deduplicate by ID keeping the last occurrence (consistent with byId Map)
  const seenIds = new Set<string>();
  const treeEntries: TreeEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry?.id) continue;
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    treeEntries.unshift(entry);
  }

  for (const entry of treeEntries) {
    nodeMap.set(entry.id, { entry, children: [], label: labelMap.get(entry.id) });
  }

  for (const entry of treeEntries) {
    const node = nodeMap.get(entry.id);
    if (!node) continue;
    if (entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  function sortChildren(node: TreeNode): void {
    node.children.sort(
      (a, b) =>
        new Date(a.entry.timestamp ?? 0).getTime() - new Date(b.entry.timestamp ?? 0).getTime(),
    );
    node.children.forEach(sortChildren);
  }
  roots.forEach(sortChildren);
  return roots;
}

// A forked session that pi later resumed (and any plain resume) is written as
// several sequential conversation segments, each beginning with its own
// parentId:null root. getPath/buildTree would treat those roots as disconnected,
// so the content pane would render only the last segment while the earlier ones
// linger in the tree as separate roots. Re-link every conversation root after the
// first onto the previous segment's most recent entry so the whole conversation
// forms one chain. The session-header line ({type:'session'}) is metadata, not a
// conversation root, and is left untouched. Returns the input unchanged when there
// is nothing to stitch (the common single-segment case).
export function stitchOrphanRoots(entries: ReadonlyArray<TreeEntry> = []): ReadonlyArray<TreeEntry> {
  let result: TreeEntry[] | null = null;
  let prevLeafId: string | null = null;
  let seenRoot = false;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry?.id || entry.type === "session" || entry.type === "label") continue;
    const isRoot =
      entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id;
    if (isRoot && seenRoot && prevLeafId) {
      result ??= entries.slice();
      result[i] = { ...entry, parentId: prevLeafId };
    }
    if (isRoot) seenRoot = true;
    prevLeafId = entry.id;
  }
  return result ?? entries;
}

export function buildActivePathIds(
  targetId: string,
  byId: ReadonlyMap<string, TreeEntry> = new Map(),
): Set<string> {
  const ids = new Set<string>();
  let current = byId.get(targetId);
  while (current) {
    ids.add(current.id);
    if (!current.parentId || current.parentId === current.id) break;
    current = byId.get(current.parentId);
  }
  return ids;
}

export function getPath(
  targetId: string,
  byId: ReadonlyMap<string, TreeEntry> = new Map(),
): TreeEntry[] {
  const path: TreeEntry[] = [];
  let current = byId.get(targetId);
  while (current) {
    path.unshift(current);
    if (!current.parentId || current.parentId === current.id) break;
    current = byId.get(current.parentId);
  }
  return path;
}

export function buildTreeNodeMap(roots: ReadonlyArray<TreeNode> = []): Map<string, TreeNode> {
  const treeNodeMap = new Map<string, TreeNode>();
  function mapNodes(node: TreeNode): void {
    treeNodeMap.set(node.entry.id, node);
    node.children.forEach(mapNodes);
  }
  roots.forEach(mapNodes);
  return treeNodeMap;
}

export function findNewestLeaf(
  nodeId: string,
  rootsOrNodeMap: ReadonlyArray<TreeNode> | Map<string, TreeNode> = [],
): string {
  const treeNodeMap =
    rootsOrNodeMap instanceof Map ? rootsOrNodeMap : buildTreeNodeMap(rootsOrNodeMap);
  const node = treeNodeMap.get(nodeId);
  if (!node) return nodeId;

  function newestNavigable(current: TreeNode): string | null {
    for (let i = current.children.length - 1; i >= 0; i -= 1) {
      const child = current.children[i];
      if (!child) continue;
      const candidate = newestNavigable(child);
      if (candidate) return candidate;
    }
    return current.entry.type === "label" ? null : current.entry.id;
  }

  return newestNavigable(node) || nodeId;
}

export function flattenTree(
  roots: ReadonlyArray<TreeNode>,
  activePathIds: ReadonlySet<string>,
): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  const multipleRoots = roots.length > 1;
  const containsActive = new Map<TreeNode, boolean>();

  function markActive(node: TreeNode): boolean {
    let has = activePathIds.has(node.entry.id);
    for (const child of node.children) {
      if (markActive(child)) has = true;
    }
    containsActive.set(node, has);
    return has;
  }
  roots.forEach(markActive);

  const stack: FlattenStackEntry[] = [];
  const orderedRoots = [...roots].sort(
    (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
  );
  for (let i = orderedRoots.length - 1; i >= 0; i -= 1) {
    const root = orderedRoots[i];
    if (!root) continue;
    const isLast = i === orderedRoots.length - 1;
    stack.push([
      root,
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
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = next;
    result.push({
      node,
      indent,
      showConnector,
      isLast,
      gutters,
      isVirtualRootChild,
      multipleRoots,
    });

    const children = node.children;
    const multipleChildren = children.length > 1;
    const orderedChildren = [...children].sort(
      (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
    );
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

    for (let i = orderedChildren.length - 1; i >= 0; i -= 1) {
      const child = orderedChildren[i];
      if (!child) continue;
      const childIsLast = i === orderedChildren.length - 1;
      stack.push([
        child,
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }

  return result;
}

export function buildTreePrefix(flatNode: FlatTreeNode): string {
  const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } = flatNode;
  const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
  const connector = showConnector && !isVirtualRootChild ? (isLast ? "└─ " : "├─ ") : "";
  const connectorPosition = connector ? displayIndent - 1 : -1;
  const totalChars = displayIndent * 3;
  const prefixChars = [];
  for (let i = 0; i < totalChars; i += 1) {
    const level = Math.floor(i / 3);
    const posInLevel = i % 3;
    const gutter = gutters.find((g) => g.position === level);
    if (gutter) prefixChars.push(posInLevel === 0 ? (gutter.show ? "│" : " ") : " ");
    else if (connector && level === connectorPosition)
      prefixChars.push(posInLevel === 0 ? (isLast ? "└" : "├") : posInLevel === 1 ? "─" : " ");
    else prefixChars.push(" ");
  }
  return prefixChars.join("");
}
