import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootWithApplicationContext,
  DEFAULT_APPLICATION_CONTEXT,
  parseApplicationContext,
  readApplicationContext,
} from "./application-context";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("application context", () => {
  it("defaults safely to standalone when context is absent or malformed", () => {
    expect(readApplicationContext()).toBe(DEFAULT_APPLICATION_CONTEXT);

    document.head.innerHTML =
      '<script id="pican-application-context" type="application/json">{broken</script>';
    expect(readApplicationContext()).toBe(DEFAULT_APPLICATION_CONTEXT);
    expect(parseApplicationContext({ mode: "provider-specific" })).toBe(
      DEFAULT_APPLICATION_CONTEXT,
    );
  });

  it("reads hosted mode and an optional safe host navigation URL", () => {
    document.head.innerHTML = `<script id="pican-application-context" type="application/json">
      {"mode":"hosted","hostNavigationUrl":"https://host.example/workspaces/test"}
    </script>`;

    expect(readApplicationContext()).toEqual({
      mode: "hosted",
      hostNavigationUrl: "https://host.example/workspaces/test",
    });
  });

  it("drops unsafe host navigation URLs and unknown secret fields", () => {
    expect(
      parseApplicationContext({
        mode: "hosted",
        hostNavigationUrl: "javascript:alert(1)",
        workspaceRoot: "/private/workspace",
        authToken: "secret",
        childEnv: ["TOKEN=secret"],
        provider: "secret-provider",
      }),
    ).toEqual({ mode: "hosted" });

    expect(
      parseApplicationContext({
        mode: "hosted",
        hostNavigationUrl: "https://user:password@host.example/",
      }),
    ).toEqual({ mode: "hosted" });
  });

  it("parses context before invoking the mount callback", () => {
    document.head.innerHTML = `<script id="pican-application-context" type="application/json">
      {"mode":"hosted","hostNavigationUrl":"/workspaces/test"}
    </script>`;
    const mount = vi.fn((context) => context.mode);

    const result = bootWithApplicationContext(mount);

    expect(result).toBe("hosted");
    expect(mount).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledWith({
      mode: "hosted",
      hostNavigationUrl: "/workspaces/test",
    });
  });
});
