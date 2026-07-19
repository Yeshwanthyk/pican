import type { SessionEntry } from "../../../session/data/session-types";
import type { NavigateTo } from "../../../session/session-runtime-context";

export function navigateInitialChatLeaf({
  entries = [],
  leafId = "",
  urlTargetId = "",
  byId = new Map<string, unknown>(),
  navigateTo = () => undefined,
}: {
  readonly entries?: readonly SessionEntry[];
  readonly leafId?: string;
  readonly urlTargetId?: string;
  readonly byId?: ReadonlyMap<string, unknown>;
  readonly navigateTo?: NavigateTo;
} = {}): void {
  if (leafId) {
    if (urlTargetId && byId.has(urlTargetId)) {
      navigateTo(leafId, "target", urlTargetId);
    } else {
      navigateTo(leafId, "none");
    }
    return;
  }

  if (entries.length > 0) {
    const last = entries.at(-1);
    if (last?.id) navigateTo(last.id, "none");
  }
}
