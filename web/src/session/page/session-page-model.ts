import { createSessionDataModel, decodeBase64JSON } from "../data/session-data.js";
import { createSessionNavigator } from "../navigation/session-navigation.js";
import { setSessionRuntime } from "../session-runtime-context.js";
import type { NavigateTo, SessionRuntimeContext } from "../session-runtime-context.js";

interface HydratableSessionModel {
  load(value: unknown): void;
  reconcile(entries: ReadonlyArray<unknown>, options?: unknown): unknown;
  currentLeafId?: string;
  currentTargetId?: string;
  [key: string]: unknown;
}

interface AtobWindow {
  atob?(value: string): string;
}

export function hydrateSessionModel({
  sessionModel,
  payloadBase64,
  locationSearch = "",
  windowImpl = window,
}: {
  readonly sessionModel: HydratableSessionModel;
  readonly payloadBase64: string;
  readonly locationSearch?: string;
  readonly windowImpl?: AtobWindow;
}): HydratableSessionModel {
  sessionModel.load(
    createSessionDataModel(
      decodeBase64JSON(payloadBase64, { atobImpl: windowImpl.atob?.bind(windowImpl) }),
      new URLSearchParams(locationSearch),
    ),
  );
  return sessionModel;
}

export function createLiveSessionRuntime({
  sessionModel,
  contentRuntime,
  documentImpl = document,
}: {
  readonly sessionModel: HydratableSessionModel;
  readonly contentRuntime: { afterRender: ((container: HTMLElement) => void) | null };
  readonly documentImpl?: Document;
}): SessionRuntimeContext & {
  readonly navigateTo: NavigateTo;
  readonly reconcileEntries: (entries: ReadonlyArray<unknown>, options?: unknown) => unknown;
} {
  const navigator = createSessionNavigator({
    documentImpl,
    onNavigate: (leaf: string, target: string) => {
      sessionModel.currentLeafId = leaf;
      sessionModel.currentTargetId = target;
    },
  });

  const runtime = {
    model: sessionModel,
    navigator,
    navigateTo: navigator.navigateTo,
    reconcileEntries: (entries: ReadonlyArray<unknown>, opts?: unknown) =>
      sessionModel.reconcile(entries, opts),
    contentRuntime,
  };
  setSessionRuntime(runtime);
  return runtime;
}
