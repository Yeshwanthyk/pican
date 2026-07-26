import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startHostedCodexServer } from "../lib/server";

function readTree(root: string): Buffer[] {
  const files: Buffer[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...readTree(path));
    } else {
      files.push(readFileSync(path));
    }
  }
  return files;
}

test("mounted hosted Codex shell, create, prompt, and SSE stay below /s/test", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "one browser covers the mounted hosting contract");
  const hosted = await startHostedCodexServer();
  const forbidden = [hosted.proxyToken, hosted.realSecretFixture];

  try {
    const proxyHeaders = { [hosted.proxyHeader]: hosted.proxyToken };
    await page.setExtraHTTPHeaders(proxyHeaders);

    const outside = await page.request.get(hosted.baseURL + "/", { headers: proxyHeaders });
    expect(outside.status()).toBe(404);

    const unauthenticated = await fetch(hosted.baseURL + hosted.basePath + "/");
    expect(unauthenticated.status).toBe(401);

    const shell = await page.request.get(hosted.baseURL + hosted.basePath + "/", {
      headers: proxyHeaders,
    });
    expect(shell.status()).toBe(200);
    const html = await shell.text();
    expect(html).toContain('name="pican-base-path" content="/s/test"');
    const script = html.match(/src="(\/s\/test\/static\/assets\/[^"]+\.js)"/)?.[1];
    const styles = Array.from(html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)).map(
      (match) => match[1],
    );
    expect(script).toBeTruthy();
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every((path) => path.startsWith("/s/test/"))).toBe(true);
    for (const path of [
      script!,
      ...styles,
      "/s/test/app-icon.png",
      "/s/test/manifest.webmanifest",
      "/s/test/sw.js",
    ]) {
      const asset = await page.request.get(hosted.baseURL + path, { headers: proxyHeaders });
      expect(asset.status(), path).toBe(200);
    }

    const runtimes = await page.request.get(hosted.baseURL + "/s/test/api/runtimes", {
      headers: proxyHeaders,
    });
    expect(runtimes.status()).toBe(200);
    expect(await runtimes.json()).toMatchObject({
      defaultRuntime: "codex",
    });

    await page.goto(hosted.baseURL + hosted.basePath + "/");
    await expect(page.locator("body")).toBeVisible();

    const sessionID = "codex-thread-e2e-1.jsonl";
    const previewPromise = page.evaluate(
      ({ url, sessionID }) =>
        new Promise<string>((resolve, reject) => {
          const source = new EventSource(`${url}/s/test/events?id=${sessionID}`);
          const timer = window.setTimeout(() => {
            source.close();
            reject(new Error("timed out waiting for mounted chat-preview SSE"));
          }, 10_000);
          source.addEventListener("chat-preview", (event) => {
            const data = JSON.parse((event as MessageEvent).data);
            if (String(data.content).includes("hello from mounted e2e")) {
              window.clearTimeout(timer);
              source.close();
              resolve(data.content);
            }
          });
        }),
      { url: hosted.baseURL, sessionID },
    );

    const created = await page.request.post(hosted.baseURL + "/s/test/api/new-session", {
      headers: {
        ...proxyHeaders,
        "Content-Type": "application/json",
        "Idempotency-Key": "scotty-session-e2e",
      },
      data: {
        path: hosted.workspaceRoot,
        runtime: "codex",
        initialPrompt: "prove mounted prompt dispatch",
      },
    });
    expect(created.status()).toBe(200);
    const body = await created.json();
    expect(body).toMatchObject({
      ok: true,
      id: sessionID,
      runtime: "codex",
      nativeId: "thread-e2e-1",
      createState: "created",
      promptDispatchState: "accepted",
    });
    await expect(previewPromise).resolves.toContain("hello from mounted e2e");

    await page.getByRole("button", { name: "New session" }).click();
    await page.locator("#sessionPath").fill(hosted.workspaceRoot);
    await expect(page.locator("#createBtn")).toBeEnabled();
    const uiCreateRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/s/test/api/new-session"),
    );
    await page.locator("#createBtn").click();
    const browserCreate = await uiCreateRequest;
    expect(browserCreate.headers()["idempotency-key"]).toBeTruthy();
    await expect(page).toHaveURL(/\/s\/test\/session\?id=codex-thread-e2e-2\.jsonl$/);

    const surfaces = [html, JSON.stringify(body), hosted.logs()];
    if (statSync(hosted.stateRoot).isDirectory()) {
      surfaces.push(...readTree(hosted.stateRoot).map((contents) => contents.toString("utf8")));
    }
    for (const secret of forbidden) {
      expect(surfaces.join("\n")).not.toContain(secret);
    }
  } finally {
    hosted.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (hosted.child.exitCode !== null) {
        resolve();
        return;
      }
      hosted.child.once("exit", () => resolve());
    });
  }
});
