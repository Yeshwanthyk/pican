import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { flushSync, unmount } from "svelte";
import { mountApp } from "./main";

let mounted: ReturnType<typeof mountApp> = null;

beforeEach(() => {
  document.body.innerHTML = "";
  mounted = null;
});

afterEach(() => {
  if (mounted) unmount(mounted);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("does not mount when no #app target exists", () => {
    expect(mountApp()).toBeNull();
  });

  it("routes / to the Svelte sessions page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/" } });

    expect(document.querySelector(".header-title-desktop")?.textContent).toContain("pican");
    expect(document.querySelector("[data-sessions-content]")).toBeTruthy();
  });

  it("routes /session to the Svelte session page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/session" } });
    // SessionPage marks the document on mount; the loading indicator itself is
    // delayed (no flash) so the class is the reliable "mounted" signal.
    flushSync();

    expect(document.documentElement.classList.contains("pican-session-page")).toBe(true);
  });

  it("routes /settings to the Svelte settings page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/settings" } });

    expect(document.querySelector(".session-header-title")?.textContent).toBe("Settings");
    expect(document.querySelector('[data-setting="pican-theme"]')).toBeTruthy();
  });

  it("routes /workflows to the Svelte workflows page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/workflows" } });

    expect(document.querySelector(".session-header-title")?.textContent).toBe("Workflows");
    expect(document.querySelector("[data-workflows-page]")).toBeTruthy();
  });

  it("passes the session query to the workflows page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/workflows", search: "?session=session.jsonl" } });

    expect(document.querySelector(".workflow-session-scope")?.getAttribute("href")).toBe(
      "/session?id=session.jsonl",
    );
  });

  it("passes project and session queries to the tasks page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({
      props: { path: "/tasks", search: "?session=session.jsonl&project=%2Frepo" },
    });

    expect(document.querySelector(".tasks-session-scope")?.getAttribute("href")).toBe(
      "/session?id=session.jsonl",
    );
    expect(document.querySelector("#tasks-project")).toBeNull();
  });

  it("routes /subagents to the Svelte subagents page", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/subagents" } });

    expect(document.querySelector(".session-header-title")?.textContent).toBe("Subagents");
    expect(document.querySelector(".session-header-bar--subagents")).not.toBeNull();
    expect(document.querySelector(".session-header-route-mark")).not.toBeNull();
    expect(document.querySelector("[data-subagents-page]")).toBeTruthy();
  });

  it("renders the subagents list with summary, markers, hrefs, and running-first order", async () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/subagents")) {
        return Promise.resolve(
          Response.json({
            subagents: [
              {
                id: "sa-1",
                title: "CLI-2 packaging sync",
                harness: "pi",
                status: "running",
                spawnedAt: ago(30_000),
                parentSession: "parent.jsonl",
                parentProject: "/repo",
                childSession: "child.jsonl",
                childProject: "/repo",
                lastActivity: new Date(now).toISOString(),
              },
              {
                id: "sa-2",
                title: "Docs audit",
                harness: "pi",
                status: "done",
                spawnedAt: ago(120_000),
                parentSession: "parent.jsonl",
                parentProject: "/repo",
                childSession: "done-child.jsonl",
                childProject: "/repo",
                lastActivity: ago(60_000),
              },
              {
                id: "sa-3",
                title: "Broken attempt",
                harness: "claude",
                status: "error",
                spawnedAt: ago(240_000),
                parentSession: "parent.jsonl",
                parentProject: "/repo",
                childSession: "failed-child.jsonl",
                childProject: "/repo",
                lastActivity: ago(180_000),
              },
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.spyOn(window, "fetch").mockImplementation(fetchSpy);
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/subagents" } });
    flushSync();

    await vi.waitFor(() => {
      expect(document.querySelector(".subagent-card")).not.toBeNull();
    });

    const summary = document.querySelector(".subagents-summary");
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain("1 running");
    expect(summary?.textContent).toContain("1 done");
    expect(summary?.textContent).toContain("1 failed");
    // Zero-count groups are hidden: no unknown subagents were stubbed.
    expect(summary?.querySelector('[data-summary="unknown"]')).toBeNull();

    const runningCard = document.querySelector<HTMLElement>(
      '.subagent-card[data-status="running"]',
    );
    expect(runningCard).not.toBeNull();
    const runningLink = runningCard?.querySelector(".subagent-card-link");
    expect(runningLink?.getAttribute("href")).toContain("child.jsonl");
    expect(runningLink?.getAttribute("href")).toContain("parent=parent.jsonl");
    expect(runningLink?.getAttribute("aria-label")).toContain("CLI-2 packaging sync");

    const doneCard = document.querySelector('.subagent-card[data-status="done"]');
    expect(doneCard?.querySelector(".subagent-marker svg")).not.toBeNull();

    // Running-first DOM order, then failures, then settled (recency within group).
    const cards = document.querySelectorAll(".subagent-card");
    expect(cards.length).toBe(3);
    expect(cards[0]?.getAttribute("data-status")).toBe("running");
    expect(cards[1]?.getAttribute("data-status")).toBe("error");
    expect(cards[2]?.getAttribute("data-status")).toBe("done");

    // list/listitem semantics and the page marker survive the data render.
    expect(document.querySelector(".subagents-list")?.getAttribute("role")).toBe("list");
    expect(document.querySelector("[data-subagents-page]")).toBeTruthy();
  });

  it("renders the 404 page for unknown routes", () => {
    document.body.innerHTML = '<div id="app"></div>';

    mounted = mountApp({ props: { path: "/future-route" } });

    expect(document.querySelector("[data-not-found]")).toBeTruthy();
    expect(document.querySelector(".not-found-code")?.textContent).toBe("404");
    expect(document.querySelector(".not-found-home")?.getAttribute("href")).toBe("/");
  });

  it("swaps views on pushState navigation", () => {
    document.body.innerHTML = '<div id="app"></div>';
    mounted = mountApp({ props: { path: "/" } });
    flushSync(); // let onMount attach the history listeners
    expect(document.querySelector("[data-sessions-content]")).toBeTruthy();

    window.history.pushState({}, "", "/settings");
    flushSync();

    expect(document.querySelector(".session-header-title")?.textContent).toBe("Settings");
  });

  it("remounts SessionsPage when its scope or project query changes", async () => {
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) {
        return Promise.resolve(Response.json({ sessions: [], total: 0 }));
      }
      if (url === "/api/projects") return Promise.resolve(Response.json({ projects: [] }));
      if (url === "/api/recent-locations") {
        return Promise.resolve(Response.json({ locations: [] }));
      }
      if (url === "/api/peers") return Promise.resolve(Response.json({ peers: [] }));
      return Promise.resolve(Response.json({}));
    });
    vi.spyOn(window, "fetch").mockImplementation(fetchSpy);
    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/?view=all");
    mounted = mountApp({ props: { path: "/", search: "?view=all" } });
    flushSync();

    await vi.waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url]) =>
          String(url).includes("/api/sessions?limit=100&view=all"),
        ),
      ).toBe(true);
    });

    fetchSpy.mockClear();
    window.history.pushState({}, "", "/?project=%2Frepo");
    flushSync();

    await vi.waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url]) =>
          String(url).includes("/api/sessions?limit=100&project=%2Frepo"),
        ),
      ).toBe(true);
    });
  });

  it("collapses the home rail when there is nothing to show", async () => {
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) {
        return Promise.resolve(Response.json({ sessions: [], total: 0 }));
      }
      if (url === "/api/projects") return Promise.resolve(Response.json({ projects: [] }));
      if (url === "/api/recent-locations") {
        return Promise.resolve(Response.json({ locations: [] }));
      }
      if (url === "/api/peers") return Promise.resolve(Response.json({ peers: [] }));
      return Promise.resolve(Response.json({}));
    });
    vi.spyOn(window, "fetch").mockImplementation(fetchSpy);
    document.body.innerHTML = '<div id="app"></div>';
    mounted = mountApp({ props: { path: "/" } });
    flushSync();

    await vi.waitFor(() => {
      expect(document.querySelector(".home-layout--no-rail")).toBeTruthy();
    });
    expect(document.querySelector(".home-rail")).toBeNull();
  });

  it("keeps the home rail when a session is waiting", async () => {
    const now = new Date().toISOString();
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) {
        return Promise.resolve(
          Response.json({
            sessions: [
              {
                id: "waiting.jsonl",
                name: "Release",
                project: "/repo",
                waitingQuestion: "Ship it?",
                waitingOptions: ["Ship", "Hold"],
                lastActivity: now,
              },
            ],
            total: 1,
          }),
        );
      }
      if (url === "/api/projects") return Promise.resolve(Response.json({ projects: [] }));
      if (url === "/api/recent-locations") {
        return Promise.resolve(Response.json({ locations: [] }));
      }
      if (url === "/api/peers") return Promise.resolve(Response.json({ peers: [] }));
      return Promise.resolve(Response.json({}));
    });
    vi.spyOn(window, "fetch").mockImplementation(fetchSpy);
    document.body.innerHTML = '<div id="app"></div>';
    mounted = mountApp({ props: { path: "/" } });
    flushSync();

    await vi.waitFor(() => {
      expect(document.querySelector(".home-rail")).toBeTruthy();
    });
    expect(document.querySelector(".home-layout--no-rail")).toBeNull();
  });

  it("swaps views on browser back/forward (popstate)", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/");
    mounted = mountApp({ props: { path: "/" } });
    flushSync(); // let onMount attach the history listeners

    window.history.pushState({}, "", "/settings");
    flushSync();
    expect(document.querySelector(".settings-page")).toBeTruthy();

    const popped = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    window.history.back();
    await popped;
    flushSync();

    expect(document.querySelector("[data-sessions-content]")).toBeTruthy();
  });

  it("does not swap when pushState keeps the same pathname", () => {
    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/settings");
    mounted = mountApp({ props: { path: "/settings" } });
    flushSync(); // let onMount attach the history listeners
    expect(document.querySelector(".settings-page")).toBeTruthy();

    // Mirrors FullScreenSheet's mobile back-button trap: a pushState that keeps
    // the pathname must not tear down and remount the current page.
    window.history.pushState({}, "", "/settings?sheet=1");
    flushSync();

    expect(document.querySelector(".settings-page")).toBeTruthy();
  });

  // SessionPage fetches /api/session?id=<id> as it mounts, so a fetch for the new
  // id is a reliable "it remounted and loaded the new session" signal.
  it("remounts SessionPage on session→session navigation (?id change)", () => {
    const fetchSpy = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(new Response("{}", { status: 500 })),
    );
    vi.spyOn(window, "fetch").mockImplementation(fetchSpy);
    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/session?id=A");
    mounted = mountApp({ props: { path: "/session", search: "?id=A" } });
    flushSync();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("id=A"))).toBe(true);

    fetchSpy.mockClear();
    window.history.pushState({}, "", "/session?id=B");
    flushSync();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("id=B"))).toBe(true);
  });

  it("restores exact per-session draft and transcript state across keyed remounts", async () => {
    class FakeEventSource {
      readonly readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(_url: string | URL) {}
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(window, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/session") {
        const id = url.searchParams.get("id") || "unknown";
        return Promise.resolve(
          Response.json({
            header: { cwd: "" },
            name: `Session ${id}`,
            entries: [
              {
                type: "message",
                id: `${id}-message`,
                parentId: null,
                message: { role: "user", content: "hello" },
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/sessions") {
        return Promise.resolve(Response.json({ sessions: [], total: 0 }));
      }
      if (url.pathname === "/api/settings") {
        return Promise.resolve(Response.json({ settings: {} }));
      }
      return Promise.resolve(new Response("{}", { status: 500 }));
    });

    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/session?id=alpha");
    mounted = mountApp({ props: { path: "/session", search: "?id=alpha" } });
    flushSync();

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLTextAreaElement>("#pi-chat-message")).not.toBeNull();
    });
    const alphaTextarea = document.querySelector<HTMLTextAreaElement>("#pi-chat-message");
    const alphaContent = document.querySelector<HTMLElement>("#content");
    expect(alphaTextarea).not.toBeNull();
    expect(alphaContent).not.toBeNull();
    if (!alphaTextarea || !alphaContent) return;

    alphaTextarea.value = "  alpha draft\nwith exact spacing  ";
    alphaTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    Object.defineProperty(alphaContent, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(alphaContent, "clientHeight", { value: 500, configurable: true });
    alphaContent.scrollTop = 321;
    alphaContent.dispatchEvent(new Event("scroll"));

    window.history.pushState({}, "", "/session?id=beta");
    flushSync();
    await vi.waitFor(() => {
      expect(document.querySelector("#session-header-title")?.textContent).toContain(
        "Session beta",
      );
    });

    window.history.pushState({}, "", "/session?id=alpha");
    flushSync();
    await vi.waitFor(() => {
      const restoredTextarea = document.querySelector<HTMLTextAreaElement>("#pi-chat-message");
      expect(restoredTextarea).not.toBe(alphaTextarea);
      expect(restoredTextarea?.value).toBe("  alpha draft\nwith exact spacing  ");
      expect(document.querySelector<HTMLElement>("#content")?.scrollTop).toBe(321);
      expect(document.querySelector(".follow-button")).not.toBeNull();
    });
  });

  it("does not remount SessionPage when the id is unchanged", () => {
    const fetchSpy = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(new Response("{}", { status: 500 })),
    );
    vi.spyOn(window, "fetch").mockImplementation(fetchSpy);
    document.body.innerHTML = '<div id="app"></div>';
    window.history.pushState({}, "", "/session?id=A");
    mounted = mountApp({ props: { path: "/session", search: "?id=A" } });
    flushSync();

    // A within-session URL change (non-id query param) must not tear down and
    // reload the live session view.
    fetchSpy.mockClear();
    window.history.pushState({}, "", "/session?id=A&panel=tree");
    flushSync();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
