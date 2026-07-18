import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { setupSessionUi } from './session-ui-runner.js';
import * as searchFiltersApi from './search-filters.js';
import * as sidebarApi from './sidebar.js';
import * as toggleStateApi from './toggle-state.js';
import { sessionRuntime, resetSessionRuntime } from '../session-runtime.js';

afterEach(() => resetSessionRuntime());

function baseDom() {
  const dom = new JSDOM(
    '<body><button id="hamburger"></button><div id="sidebar"></div><div id="sidebar-overlay"></div><button id="sidebar-close"></button><input id="tree-search"><button class="filter-btn" data-filter="all"></button></body>',
  );
  dom.window.matchMedia = () => ({ matches: false });
  return dom;
}

function setupUi(dom, overrides = {}) {
  const markdownApi = {
    configureSessionMarkdown: vi.fn(),
    safeMarkedParse: vi.fn((text) => `<p>${text}</p>`),
  };
  return {
    markdownApi,
    result: setupSessionUi({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      storage: { getItem: () => null, setItem: vi.fn() },
      marked: {},
      hljs: {},
      escapeHtml: String,
      markdownApi,
      searchFiltersApi,
      sidebarApi,
      toggleStateApi,
      getLeafId: () => 'leaf',
      setSearchQuery: vi.fn(),
      setFilterMode: vi.fn(),
      forceTreeRerender: vi.fn(),
      navigateTo: vi.fn(),
      ...overrides,
    }),
  };
}

describe('session UI runner', () => {
  it('sets up markdown, sidebar helpers, and toggles', () => {
    const dom = baseDom();
    const { markdownApi, result } = setupUi(dom);
    expect(markdownApi.configureSessionMarkdown).toHaveBeenCalled();
    expect(result.safeMarkedParse('x')).toBe('<p>x</p>');
    expect(sessionRuntime.toggleState).toBeTruthy();
    expect(typeof result.attachHeaderHandlers).toBe('function');
    expect(typeof result.isMobileLayout).toBe('function');
    expect(typeof result.closeSidebar).toBe('function');
  });

  it('the export-only hamburger opens and overlay/close close the docked sidebar', () => {
    const dom = baseDom();
    setupUi(dom);
    const { document: doc } = dom.window;

    doc.getElementById('hamburger').click();
    expect(doc.getElementById('sidebar').classList.contains('open')).toBe(true);

    doc.getElementById('sidebar-overlay').click();
    expect(doc.getElementById('sidebar').classList.contains('open')).toBe(false);

    doc.getElementById('hamburger').click();
    expect(doc.getElementById('sidebar').classList.contains('open')).toBe(true);
    doc.getElementById('sidebar-close').click();
    expect(doc.getElementById('sidebar').classList.contains('open')).toBe(false);
  });
});
