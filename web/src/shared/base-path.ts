const META_NAME = "pican-base-path";

function normalize(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (trimmed === "" || trimmed === "/") return "";
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/+$/, "");
}

function documentBasePath(): string {
  if (typeof document === "undefined") return "";
  return normalize(document.querySelector<HTMLMetaElement>(`meta[name="${META_NAME}"]`)?.content);
}

let configuredBasePath: string | undefined;

export function basePath(): string {
  return configuredBasePath === undefined ? documentBasePath() : configuredBasePath;
}

export function configureBasePath(value: string | null | undefined): void {
  configuredBasePath = normalize(value);
}

export function resetBasePath(): void {
  configuredBasePath = undefined;
}

export function withBasePath(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const prefix = basePath();
  if (prefix === "" || url === prefix || url.startsWith(`${prefix}/`)) return url;
  return `${prefix}${url}`;
}

export function stripBasePath(pathname: string): string {
  const prefix = basePath();
  if (prefix === "") return pathname || "/";
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname || "/";
}
