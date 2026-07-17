import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRuntime,
  resetSessionRuntimeContext,
  setSessionRuntime,
} from './session-runtime-context.js';

describe('session runtime context', () => {
  afterEach(() => {
    resetSessionRuntimeContext();
  });

  it('stores an explicit runtime and derives navigateTo from the navigator', () => {
    const navigateTo = vi.fn();
    const model = { entries: [] };
    const runtime = setSessionRuntime({ model, navigator: { navigateTo } });

    expect(runtime.navigateTo).toBe(navigateTo);
    expect(getSessionRuntime().model).toBe(model);
  });

  it('resets the runtime without installing window compatibility shims', () => {
    const model = { entries: [] };
    const navigateTo = vi.fn();
    const reconcileEntries = vi.fn();
    const contentRuntime = { afterRender: null };

    setSessionRuntime({
      model,
      navigateTo,
      navigator: { navigateTo },
      reconcileEntries,
      contentRuntime,
    });

    expect(getSessionRuntime().model).toBe(model);
    expect(getSessionRuntime().navigateTo).toBe(navigateTo);
    expect(window.__piSessionDataModel).toBeUndefined();
    expect(window.navigateTo).toBeUndefined();
    expect(window.__piReconcileEntries).toBeUndefined();
    expect(window.__piContentRuntime).toBeUndefined();

    resetSessionRuntimeContext();

    expect(getSessionRuntime().model).toBeUndefined();
  });
});
