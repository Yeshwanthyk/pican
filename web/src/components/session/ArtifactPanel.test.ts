import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import ArtifactPanel from "./ArtifactPanel.svelte";
import { sessionRuntime, resetSessionRuntime } from "../../session/session-runtime.js";

type Highlight = (code: string, language: string) => string | null;
interface PanelProps {
  readonly highlight?: Highlight | null;
  readonly renderMarkdown?: ((text: string) => string) | null;
}
interface PanelHandle {
  readonly setArtifacts: (
    artifacts: ReadonlyArray<unknown>,
    options?: { readonly hiddenCount?: number },
  ) => void;
  readonly selectArtifact: (id: string) => void;
  readonly getSelectedId: () => string;
  readonly getCount: () => number;
}

function query<ElementType extends Element = HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  assert(element);
  return element;
}

afterEach(() => {
  cleanup();
  resetSessionRuntime();
  vi.restoreAllMocks();
});

// `highlight: () => null` keeps the source view deterministic (plain text +
// data-highlight-pending) and skips the component's lazy highlight.js import.
function renderPanel(props: PanelProps = {}): PanelHandle {
  render(ArtifactPanel, { props: { highlight: () => null, ...props } });
  const runtime = sessionRuntime.artifacts;
  assert(runtime?.setArtifacts);
  assert(runtime.selectArtifact);
  assert(runtime.getSelectedId);
  assert(runtime.getCount);
  return {
    setArtifacts: runtime.setArtifacts,
    selectArtifact: runtime.selectArtifact,
    getSelectedId: runtime.getSelectedId,
    getCount: runtime.getCount,
  };
}

const arts = [
  {
    id: "a1",
    kind: "code",
    title: "util.go",
    lang: "go",
    content: "package main",
    filePath: "src/util.go",
  },
  {
    id: "a2",
    kind: "preview",
    previewType: "html",
    title: "page.html",
    lang: "html",
    content: "<h1>hi</h1>",
    filePath: "page.html",
  },
];

describe("ArtifactPanel", () => {
  it("renders an empty state with no artifacts", async () => {
    const panel = renderPanel();
    panel.setArtifacts([]);
    await tick();
    expect(document.querySelector(".artifact-empty")).not.toBeNull();
    expect(panel.getCount()).toBe(0);
  });

  it("shows a filter hint in the empty state when artifacts are hidden", async () => {
    const panel = renderPanel();
    panel.setArtifacts([], { hiddenCount: 3 });
    await tick();
    const empty = query(".artifact-empty");
    expect(empty.textContent).toContain("3 artifacts hidden by your filter");
    expect(empty.querySelector('a[href="/settings"]')).not.toBeNull();
  });

  it("singularizes the filter hint for a single hidden artifact", async () => {
    const panel = renderPanel();
    panel.setArtifacts([], { hiddenCount: 1 });
    await tick();
    expect(query(".artifact-empty").textContent).toContain("1 artifact hidden");
  });

  it("lists artifacts and auto-selects the first", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    await tick();
    expect(document.querySelectorAll(".artifact-list-item")).toHaveLength(2);
    expect(panel.getSelectedId()).toBe("a1");
    expect(query<HTMLElement>(".artifact-list-item.active").dataset.artifactId).toBe("a1");
    expect(query(".artifact-view-title").textContent).toBe("util.go");
    expect(query(".artifact-source").textContent).toContain("package main");
  });

  it("shows a preview badge for preview-kind artifacts", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    await tick();
    const second = query('[data-artifact-id="a2"]');
    expect(second.querySelector(".artifact-badge")).not.toBeNull();
  });

  it("selects a different artifact on click", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    await tick();
    query<HTMLElement>('[data-artifact-id="a2"]').click();
    await tick();
    expect(panel.getSelectedId()).toBe("a2");
    expect(query(".artifact-view-title").textContent).toBe("page.html");
  });

  it("uses highlight output when available, else falls back to escaped text", async () => {
    const highlight = vi.fn(() => '<span class="tok">x</span>');
    renderPanel({ highlight }).setArtifacts(arts);
    await tick();
    expect(highlight).toHaveBeenCalled();
    expect(query<HTMLElement>(".artifact-source code").innerHTML).toContain("tok");
    cleanup();

    renderPanel().setArtifacts([
      { id: "x", kind: "code", title: "t", lang: "", content: "<b>raw</b>" },
    ]);
    await tick();
    expect(query<HTMLElement>(".artifact-source code").innerHTML).toContain("&lt;b&gt;");
    expect(document.querySelector("code[data-highlight-pending]")).not.toBeNull();
  });

  it("copies source to clipboard and gives feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const panel = renderPanel();
    panel.setArtifacts(arts);
    await tick();
    query<HTMLElement>('[data-action="copy"]').click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("package main");
  });

  it("downloads the selected artifact using its filename", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === "a") el.click = clickSpy;
      return el;
    });
    const panel = renderPanel();
    panel.setArtifacts(arts);
    await tick();
    query<HTMLElement>('[data-action="download"]').click();
    expect(clickSpy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("keeps the selection when setArtifacts is called with the same id", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    panel.selectArtifact("a2");
    panel.setArtifacts(arts);
    await tick();
    expect(panel.getSelectedId()).toBe("a2");
  });

  it("shows no preview toggle for code-kind artifacts", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts); // a1 (code) selected by default
    await tick();
    expect(document.querySelector('[data-action="toggle-preview"]')).toBeNull();
  });

  it("runs a preview-kind artifact in a locked-down sandboxed iframe", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    panel.selectArtifact("a2");
    await tick();

    const toggle = query<HTMLElement>('[data-action="toggle-preview"]');
    expect(toggle.textContent).toBe("Run preview");
    expect(document.querySelector(".artifact-preview")).toBeNull();

    toggle.click();
    await tick();

    const frame = query<HTMLIFrameElement>("iframe.artifact-preview");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.srcdoc).toContain("<h1>hi</h1>");
    expect(frame.srcdoc).toContain("Content-Security-Policy");
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(query('[data-action="toggle-preview"]').textContent).toBe("Show source");
    expect(document.querySelector(".artifact-source")).toBeNull();
  });

  it("renders markdown previews inline via renderMarkdown (not an iframe)", async () => {
    const renderMarkdown = vi.fn((md: string) => `<h1>${md.replace("# ", "")}</h1>`);
    const panel = renderPanel({ renderMarkdown });
    panel.setArtifacts([
      {
        id: "m1",
        kind: "preview",
        previewType: "markdown",
        title: "README.md",
        lang: "markdown",
        content: "# Hello",
      },
    ]);
    await tick();

    const toggle = query<HTMLElement>('[data-action="toggle-preview"]');
    expect(toggle.textContent).toBe("Preview");
    toggle.click();
    await tick();

    expect(renderMarkdown).toHaveBeenCalledWith("# Hello");
    expect(document.querySelector("iframe.artifact-preview")).toBeNull();
    expect(query(".artifact-markdown h1").textContent).toBe("Hello");
  });

  it("gives the source view an artifact-<id> anchor", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    await tick();
    expect(document.querySelector("pre.artifact-source#artifact-a1")).not.toBeNull();
  });

  it("toggles back from preview to source", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    panel.selectArtifact("a2");
    await tick();
    query<HTMLElement>('[data-action="toggle-preview"]').click();
    await tick();
    query<HTMLElement>('[data-action="toggle-preview"]').click();
    await tick();
    expect(document.querySelector(".artifact-preview")).toBeNull();
    expect(query(".artifact-source").textContent).toContain("<h1>hi</h1>");
  });

  it("resets to source view when a different artifact is selected", async () => {
    const panel = renderPanel();
    panel.setArtifacts(arts);
    panel.selectArtifact("a2");
    await tick();
    query<HTMLElement>('[data-action="toggle-preview"]').click();
    await tick();
    expect(document.querySelector(".artifact-preview")).not.toBeNull();

    panel.selectArtifact("a1");
    panel.selectArtifact("a2");
    await tick();
    expect(document.querySelector(".artifact-preview")).toBeNull();
    expect(query('[data-action="toggle-preview"]').textContent).toBe("Run preview");
  });
});
