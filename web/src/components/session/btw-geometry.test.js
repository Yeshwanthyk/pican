import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  BTW_GEOM_KEY,
  enableBtwDrag,
  loadBtwGeometry,
  persistBtwResize,
  placeBtwInitial,
  saveBtwGeometry,
} from './btw-geometry.js';

function storageMock(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => data.get(key) ?? null),
    setItem: vi.fn((key, value) => data.set(key, value)),
    data,
  };
}

describe('btw geometry', () => {
  it('loads and merges persisted geometry', () => {
    const storage = storageMock({ [BTW_GEOM_KEY]: JSON.stringify({ left: 10, top: 20 }) });
    expect(loadBtwGeometry({ storage })).toEqual({ left: 10, top: 20 });

    saveBtwGeometry({ width: 360 }, { storage });
    expect(JSON.parse(storage.data.get(BTW_GEOM_KEY))).toEqual({ left: 10, top: 20, width: 360 });
  });

  it('returns null for invalid storage data', () => {
    const storage = storageMock({ [BTW_GEOM_KEY]: '{bad' });
    expect(loadBtwGeometry({ storage })).toBe(null);
  });

  it('places from persisted coordinates when available', () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const root = dom.window.document.getElementById('root');
    const saveGeometry = vi.fn();
    placeBtwInitial(root, {
      windowImpl: dom.window,
      loadGeometry: () => ({ left: 12, top: 34 }),
      saveGeometry,
    });
    expect(root.style.left).toBe('12px');
    expect(root.style.top).toBe('34px');
    expect(saveGeometry).not.toHaveBeenCalled();
  });

  it('centers near the bottom and saves coordinates when no geometry exists', () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const root = dom.window.document.getElementById('root');
    root.getBoundingClientRect = () => ({ width: 300, height: 200 });
    const saveGeometry = vi.fn();

    placeBtwInitial(root, {
      windowImpl: { innerWidth: 900, innerHeight: 700 },
      loadGeometry: () => null,
      saveGeometry,
    });

    expect(root.style.left).toBe('300px');
    expect(root.style.top).toBe('410px');
    expect(saveGeometry).toHaveBeenCalledWith({ left: 300, top: 410 });
  });

  it('drags within viewport bounds and ignores action buttons', () => {
    const dom = new JSDOM(
      '<body><div id="root"><div id="handle"><div class="pi-btw-actions"><button id="action"></button></div></div></div></body>',
    );
    const root = dom.window.document.getElementById('root');
    const handle = dom.window.document.getElementById('handle');
    const action = dom.window.document.getElementById('action');
    root.getBoundingClientRect = () => ({ left: 100, top: 80, width: 200, height: 150 });
    const saveGeometry = vi.fn();

    enableBtwDrag(root, handle, {
      documentImpl: dom.window.document,
      windowImpl: { innerWidth: 250, innerHeight: 180 },
      saveGeometry,
    });

    action.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    dom.window.document.dispatchEvent(
      new dom.window.MouseEvent('pointermove', { clientX: 200, clientY: 200 }),
    );
    expect(saveGeometry).not.toHaveBeenCalled();

    handle.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 80 }),
    );
    dom.window.document.dispatchEvent(
      new dom.window.MouseEvent('pointermove', { clientX: 300, clientY: 300 }),
    );
    expect(root.style.left).toBe('50px');
    expect(root.style.top).toBe('30px');
    expect(saveGeometry).toHaveBeenCalledWith({ left: 50, top: 30 });
  });

  it('persists dimensions from ResizeObserver', () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const root = dom.window.document.getElementById('root');
    Object.defineProperty(root, 'offsetWidth', { value: 420 });
    Object.defineProperty(root, 'offsetHeight', { value: 260 });
    const saveGeometry = vi.fn();
    let resizeCallback = null;
    class ResizeObserver {
      constructor(cb) {
        resizeCallback = cb;
      }
      observe = vi.fn();
    }

    persistBtwResize(root, {
      windowImpl: {
        ResizeObserver,
        requestAnimationFrame: (cb) => {
          cb();
          return 1;
        },
        cancelAnimationFrame: vi.fn(),
      },
      saveGeometry,
    });
    resizeCallback();

    expect(saveGeometry).toHaveBeenCalledWith({ width: 420, height: 260 });
  });
});
