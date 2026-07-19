/** @type {import('knip').KnipConfig} */
export default {
  exclude: ["exports", "types", "nsExports", "nsTypes", "enumMembers", "namespaceMembers"],
  entry: ["src/main.ts", "src/export/export-entry.ts", "src/**/*.test.ts"],
  project: ["src/**/*.{ts,svelte}", "*.config.js"],
};
