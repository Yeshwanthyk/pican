/** @type {import('knip').KnipConfig} */
export default {
  exclude: ["exports", "types", "nsExports", "nsTypes", "enumMembers", "namespaceMembers"],
  entry: ["src/main.js", "src/export/export-entry.js", "src/**/*.test.{js,ts}"],
  project: ["src/**/*.{js,ts,svelte}", "*.config.{js,ts}"],
};
