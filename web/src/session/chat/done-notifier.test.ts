import { describe, it, expect, vi } from "vitest";
import {
  notifyDone,
  setupAppBadgeClearing,
  setupDoneNotifyToggle,
  clearAppBadge,
  DONE_NOTIFY_STORAGE_KEY,
} from "./done-notifier.js";

function makeStorage(enabled = true) {
  const map: Record<string, string> = { [DONE_NOTIFY_STORAGE_KEY]: String(enabled) };
  return {
    getItem: (k: string) => map[k] ?? null,
    setItem: (k: string, v: string) => {
      map[k] = v;
    },
  };
}

function makeWindow({ badgeApi = true } = {}) {
  const badgeSet: number[] = [];
  const badge = { set: badgeSet, cleared: 0 };
  const nav = badgeApi
    ? {
        setAppBadge: vi.fn(async (n: number) => {
          badge.set.push(n);
        }),
        clearAppBadge: vi.fn(async () => {
          badge.cleared += 1;
        }),
      }
    : {};
  return {
    windowImpl: {
      navigator: nav,
      Notification: null,
      addEventListener: (_type: string, _listener: EventListener) => undefined,
      removeEventListener: (_type: string, _listener: EventListener) => undefined,
    },
    badge,
  };
}

describe("setupDoneNotifyToggle", () => {
  it("removes its click listener idempotently", () => {
    document.body.innerHTML = '<button id="notify-toggle"><span></span></button>';
    const storage = makeStorage(false);
    const { windowImpl } = makeWindow();
    const dispose = setupDoneNotifyToggle({
      documentImpl: document,
      windowImpl,
      storage,
      fetchImpl: null,
    });

    dispose();
    dispose();
    document.getElementById("notify-toggle")?.click();

    expect(storage.getItem(DONE_NOTIFY_STORAGE_KEY)).toBe("false");
    document.body.innerHTML = "";
  });
});

describe("notifyDone — app badge", () => {
  it("sets badge when document is hidden", () => {
    const { windowImpl, badge } = makeWindow();
    notifyDone({ windowImpl, documentImpl: { hidden: true }, storage: makeStorage(true) });
    expect(badge.set).toEqual([1]);
  });

  it("does not set badge when document is visible", () => {
    const { windowImpl, badge } = makeWindow();
    notifyDone({ windowImpl, documentImpl: { hidden: false }, storage: makeStorage(true) });
    expect(badge.set).toEqual([]);
  });

  it("does not set badge when notifications are disabled", () => {
    const { windowImpl, badge } = makeWindow();
    notifyDone({ windowImpl, documentImpl: { hidden: true }, storage: makeStorage(false) });
    expect(badge.set).toEqual([]);
  });

  it("does nothing when Badging API is unavailable", () => {
    const { windowImpl } = makeWindow({ badgeApi: false });
    expect(() =>
      notifyDone({ windowImpl, documentImpl: { hidden: true }, storage: makeStorage(true) }),
    ).not.toThrow();
  });
});

describe("clearAppBadge", () => {
  it("calls navigator.clearAppBadge", () => {
    const { windowImpl, badge } = makeWindow();
    clearAppBadge({ windowImpl });
    expect(badge.cleared).toBe(1);
  });

  it("does nothing when Badging API is unavailable", () => {
    const { windowImpl } = makeWindow({ badgeApi: false });
    expect(() => clearAppBadge({ windowImpl })).not.toThrow();
  });
});

describe("setupAppBadgeClearing", () => {
  it("clears badge immediately if document is already visible", () => {
    const { windowImpl, badge } = makeWindow();
    const listeners: Record<string, EventListener> = {};
    const documentImpl = {
      hidden: false,
      addEventListener: (type: string, fn: EventListener) => {
        listeners[type] = fn;
      },
    };
    windowImpl.addEventListener = (type: string, fn: EventListener) => {
      listeners[type] = fn;
    };

    setupAppBadgeClearing({ documentImpl, windowImpl });

    expect(badge.cleared).toBe(1);
  });

  it("clears badge on visibilitychange when page becomes visible", () => {
    const { windowImpl, badge } = makeWindow();
    const listeners: Record<string, EventListener> = {};
    const documentImpl = {
      hidden: true,
      addEventListener: (type: string, fn: EventListener) => {
        listeners[type] = fn;
      },
    };
    windowImpl.addEventListener = (type: string, fn: EventListener) => {
      listeners[type] = fn;
    };

    setupAppBadgeClearing({ documentImpl, windowImpl });
    expect(badge.cleared).toBe(0);

    documentImpl.hidden = false;
    listeners["visibilitychange"]?.(new Event("visibilitychange"));
    expect(badge.cleared).toBe(1);
  });

  it("clears badge on window focus", () => {
    const { windowImpl, badge } = makeWindow();
    const listeners: Record<string, EventListener> = {};
    const documentImpl = {
      hidden: false,
      addEventListener: (type: string, fn: EventListener) => {
        listeners[type] = fn;
      },
    };
    windowImpl.addEventListener = (type: string, fn: EventListener) => {
      listeners[type] = fn;
    };

    setupAppBadgeClearing({ documentImpl, windowImpl });
    badge.cleared = 0; // reset after the initial clear

    listeners["focus"]?.(new Event("focus"));
    expect(badge.cleared).toBe(1);
  });

  it("removes badge-clearing listeners idempotently", () => {
    const { windowImpl } = makeWindow();
    const removeDocument = vi.fn();
    const removeWindow = vi.fn();
    const documentImpl = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: removeDocument,
    };
    windowImpl.removeEventListener = removeWindow;

    const dispose = setupAppBadgeClearing({ documentImpl, windowImpl });
    dispose();
    dispose();

    expect(removeDocument).toHaveBeenCalledTimes(1);
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledTimes(1);
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
  });
});
