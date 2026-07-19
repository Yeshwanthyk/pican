import { Effect, Schema } from "effect";
import * as Storage from "../../lib/storage";
import { runSync } from "../../lib/runtime";

export const BTW_GEOM_KEY = "pican:btw:window";

const BtwGeometrySchema = Schema.Struct({
  left: Schema.optionalKey(Schema.Number),
  top: Schema.optionalKey(Schema.Number),
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  open: Schema.optionalKey(Schema.Boolean),
});
export type BtwGeometry = typeof BtwGeometrySchema.Type;

interface GeometryOptions {
  readonly storage?: Storage.StorageLike;
  readonly key?: string;
}

export function loadBtwGeometry({
  storage,
  key = BTW_GEOM_KEY,
}: GeometryOptions = {}): BtwGeometry | null {
  return runSync(
    Storage.getJson(key, BtwGeometrySchema, storage).pipe(
      Effect.map((value) => value ?? null),
      Effect.catch(() => Effect.succeed(null)),
    ),
  );
}

export function saveBtwGeometry(
  patch: BtwGeometry,
  { storage, key = BTW_GEOM_KEY }: GeometryOptions = {},
): void {
  const current = loadBtwGeometry({ storage, key }) ?? {};
  runSync(Storage.setJsonBestEffort(key, { ...current, ...patch }, BtwGeometrySchema, storage));
}

type GeometryLoader = () => BtwGeometry | null;
type GeometrySaver = (patch: BtwGeometry) => void;

export function placeBtwInitial(
  root: HTMLElement,
  {
    windowImpl = window,
    loadGeometry = loadBtwGeometry,
    saveGeometry = saveBtwGeometry,
  }: {
    readonly windowImpl?: Pick<Window, "innerWidth" | "innerHeight">;
    readonly loadGeometry?: GeometryLoader;
    readonly saveGeometry?: GeometrySaver;
  } = {},
): void {
  const geometry = loadGeometry();
  if (geometry?.left !== undefined && geometry.top !== undefined) {
    root.style.left = `${geometry.left}px`;
    root.style.top = `${geometry.top}px`;
    return;
  }
  const rect = root.getBoundingClientRect();
  const left = Math.max(0, ((windowImpl.innerWidth || 0) - rect.width) / 2);
  const top = Math.max(0, (windowImpl.innerHeight || 0) - rect.height - 90);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  saveGeometry({ left, top });
}

export function enableBtwDrag(
  root: HTMLElement,
  handle: HTMLElement,
  {
    documentImpl = document,
    windowImpl = window,
    saveGeometry = saveBtwGeometry,
  }: {
    readonly documentImpl?: Document;
    readonly windowImpl?: Pick<Window, "innerWidth" | "innerHeight">;
    readonly saveGeometry?: GeometrySaver;
  } = {},
): void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    const rect = root.getBoundingClientRect();
    const left = Math.max(
      0,
      Math.min(originLeft + event.clientX - startX, windowImpl.innerWidth - rect.width),
    );
    const top = Math.max(
      0,
      Math.min(originTop + event.clientY - startY, windowImpl.innerHeight - rect.height),
    );
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    saveGeometry({ left, top });
  };
  const onUp = () => {
    dragging = false;
    documentImpl.removeEventListener("pointermove", onMove);
    documentImpl.removeEventListener("pointerup", onUp);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(".pi-btw-actions")) return;
    dragging = true;
    const rect = root.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    documentImpl.addEventListener("pointermove", onMove);
    documentImpl.addEventListener("pointerup", onUp);
  });
}

export function persistBtwResize(
  root: HTMLElement,
  {
    windowImpl = window,
    saveGeometry = saveBtwGeometry,
  }: {
    readonly windowImpl?: {
      readonly ResizeObserver?: typeof ResizeObserver;
      requestAnimationFrame(callback: FrameRequestCallback): number;
      cancelAnimationFrame(handle: number): void;
    };
    readonly saveGeometry?: GeometrySaver;
  } = {},
): ResizeObserver | null {
  if (!windowImpl.ResizeObserver) return null;
  let frame = 0;
  const observer = new windowImpl.ResizeObserver(() => {
    if (frame) windowImpl.cancelAnimationFrame(frame);
    frame = windowImpl.requestAnimationFrame(() =>
      saveGeometry({ width: root.offsetWidth, height: root.offsetHeight }),
    );
  });
  observer.observe(root);
  return observer;
}
