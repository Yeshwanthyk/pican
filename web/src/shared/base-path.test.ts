import { afterEach, describe, expect, it } from "vitest";
import { configureBasePath, resetBasePath, stripBasePath, withBasePath } from "./base-path";

afterEach(() => resetBasePath());

describe("mounted live URL contract", () => {
  it("prefixes live routes once under /s/test", () => {
    configureBasePath("/s/test/");
    expect(withBasePath("/api/session?id=1")).toBe("/s/test/api/session?id=1");
    expect(withBasePath("/session?id=1")).toBe("/s/test/session?id=1");
    expect(withBasePath("/s/test/sw.js")).toBe("/s/test/sw.js");
    expect(withBasePath("https://peer.example/session")).toBe("https://peer.example/session");
  });

  it("strips the mount before route parsing", () => {
    configureBasePath("/s/test");
    expect(stripBasePath("/s/test")).toBe("/");
    expect(stripBasePath("/s/test/settings")).toBe("/settings");
    expect(stripBasePath("/other")).toBe("/other");
  });
});
