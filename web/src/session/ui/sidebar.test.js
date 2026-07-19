import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { isMobileLayout, setSidebarOpen, MOBILE_BREAKPOINT_PX } from "./sidebar.js";

function dom() {
  const jsdom = new JSDOM(`<body>
    <button id="hamburger"></button>
    <aside id="sidebar"></aside>
    <div id="sidebar-overlay"></div>
  </body>`);
  jsdom.window.matchMedia = () => ({ matches: false });
  return jsdom;
}

describe("isMobileLayout", () => {
  it("reflects the media query match", () => {
    const jsdom = dom();
    jsdom.window.matchMedia = (query) => ({
      matches: query === `(max-width: ${MOBILE_BREAKPOINT_PX}px)`,
    });
    expect(isMobileLayout({ windowImpl: jsdom.window })).toBe(true);
  });

  it("returns false when matchMedia is unavailable", () => {
    expect(isMobileLayout({ windowImpl: undefined })).toBe(false);
  });
});

describe("setSidebarOpen", () => {
  it("toggles sidebar open state, overlay, and hamburger visibility", () => {
    const jsdom = dom();
    setSidebarOpen(true, { documentImpl: jsdom.window.document });
    expect(jsdom.window.document.getElementById("sidebar").classList.contains("open")).toBe(true);
    expect(jsdom.window.document.getElementById("sidebar-overlay").classList.contains("open")).toBe(
      true,
    );
    expect(jsdom.window.document.body.classList.contains("sidebar-open")).toBe(true);
    expect(jsdom.window.document.getElementById("hamburger").style.display).toBe("none");

    setSidebarOpen(false, { documentImpl: jsdom.window.document });
    expect(jsdom.window.document.getElementById("sidebar").classList.contains("open")).toBe(false);
    expect(jsdom.window.document.body.classList.contains("sidebar-open")).toBe(false);
    expect(jsdom.window.document.getElementById("hamburger").style.display).toBe("");
  });
});
