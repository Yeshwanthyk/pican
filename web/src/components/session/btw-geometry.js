export const BTW_GEOM_KEY = 'pi-btw:window';

export function loadBtwGeometry({ storage = window.localStorage, key = BTW_GEOM_KEY } = {}) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveBtwGeometry(patch, { storage = window.localStorage, key = BTW_GEOM_KEY } = {}) {
  try {
    const cur = loadBtwGeometry({ storage, key }) || {};
    storage?.setItem(key, JSON.stringify({ ...cur, ...patch }));
  } catch {
    // Storage may be unavailable in private browsing or tests.
  }
}

export function placeBtwInitial(
  root,
  { windowImpl = window, loadGeometry = loadBtwGeometry, saveGeometry = saveBtwGeometry } = {},
) {
  const geom = loadGeometry();
  if (geom && typeof geom.left === 'number' && typeof geom.top === 'number') {
    root.style.left = `${geom.left}px`;
    root.style.top = `${geom.top}px`;
    return;
  }
  const vw = windowImpl.innerWidth || 0;
  const vh = windowImpl.innerHeight || 0;
  const rect = root.getBoundingClientRect();
  const left = Math.max(0, (vw - rect.width) / 2);
  const top = Math.max(0, vh - rect.height - 90);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  saveGeometry({ left, top });
}

export function enableBtwDrag(
  root,
  handle,
  { documentImpl = document, windowImpl = window, saveGeometry = saveBtwGeometry } = {},
) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  function onMove(event) {
    if (!dragging) return;
    const vw = windowImpl.innerWidth || 0;
    const vh = windowImpl.innerHeight || 0;
    const rect = root.getBoundingClientRect();
    const left = Math.max(0, Math.min(originLeft + (event.clientX - startX), vw - rect.width));
    const top = Math.max(0, Math.min(originTop + (event.clientY - startY), vh - rect.height));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    saveGeometry({ left, top });
  }

  function onUp() {
    dragging = false;
    documentImpl.removeEventListener('pointermove', onMove);
    documentImpl.removeEventListener('pointerup', onUp);
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.target && event.target.closest && event.target.closest('.pi-btw-actions')) return;
    dragging = true;
    const rect = root.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    documentImpl.addEventListener('pointermove', onMove);
    documentImpl.addEventListener('pointerup', onUp);
  });
}

export function persistBtwResize(
  root,
  { windowImpl = window, saveGeometry = saveBtwGeometry } = {},
) {
  if (!windowImpl.ResizeObserver) return null;
  let raf = 0;
  const observer = new windowImpl.ResizeObserver(() => {
    if (raf) windowImpl.cancelAnimationFrame?.(raf);
    raf = windowImpl.requestAnimationFrame
      ? windowImpl.requestAnimationFrame(() =>
          saveGeometry({ width: root.offsetWidth, height: root.offsetHeight }),
        )
      : 0;
  });
  observer.observe(root);
  return observer;
}
