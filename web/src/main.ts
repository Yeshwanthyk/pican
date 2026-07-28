import { mount } from "svelte";
import App from "./App.svelte";
import { bootWithApplicationContext, type ApplicationContext } from "./shared/application-context";

function defaultTarget() {
  if (typeof document === "undefined") return null;
  return document.getElementById("spa-root") || document.getElementById("app");
}

export interface AppProps {
  readonly path?: string;
  readonly search?: string;
  readonly applicationContext?: ApplicationContext;
}

export function mountApp({
  target = defaultTarget(),
  props = {},
}: { readonly target?: Element | null; readonly props?: AppProps } = {}) {
  if (!target) return null;
  return bootWithApplicationContext((applicationContext) =>
    mount(App, { target, props: { ...props, applicationContext } }),
  );
}

const appTarget = typeof document !== "undefined" ? defaultTarget() : null;
if (appTarget && !appTarget.dataset.picanSvelteMounted) {
  appTarget.dataset.picanSvelteMounted = "true";
  mountApp({ target: appTarget });
}
