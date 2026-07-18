import { defineConfig } from "vitepress";

const SITE_ORIGIN = "https://ygncode.github.io";
const BASE = "/pi-web/";
const OG_IMAGE = `${SITE_ORIGIN}${BASE}assets/og-image.png`;

// Project Pages site: served under https://ygncode.github.io/pi-web/
// so every asset/link must resolve under the `/pi-web/` base path.
export default defineConfig({
  base: BASE,
  srcDir: "src",
  outDir: "dist",
  cleanUrls: true,
  title: "pi-web",
  description:
    "A beautiful web UI and PWA for pi — browse, read, and continue your AI coding sessions from any browser, on any device.",
  // The nav ThemeSwitcher owns theming (4 named themes), so disable VitePress's
  // own light/dark toggle. Set the saved theme (default dracula) before first
  // paint to avoid a flash.
  appearance: false,
  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: "/pi-web/assets/icon.svg" },
    ],
    ["meta", { name: "theme-color", content: "#282a36" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "pi-web" }],
    ["meta", { property: "og:image", content: OG_IMAGE }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:image", content: OG_IMAGE }],
    [
      "script",
      {},
      "(function(){try{var t=localStorage.getItem('pi-web-docs-theme')||'dracula';var d=document.documentElement;d.dataset.theme=t;d.classList.toggle('dark',t!=='light');}catch(e){}})()",
    ],
  ],
  sitemap: { hostname: `${SITE_ORIGIN}${BASE}` },
  // Per-page OpenGraph/Twitter/canonical tags (title, description, URL, locale).
  transformHead({ pageData, siteData }) {
    const title =
      pageData.frontmatter.title || pageData.title || siteData.title;
    const description =
      pageData.frontmatter.description ||
      pageData.description ||
      siteData.description;
    const path = pageData.relativePath
      .replace(/(^|\/)index\.md$/, "$1")
      .replace(/\.md$/, "");
    const url = `${SITE_ORIGIN}${BASE}${path}`;
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:locale", content: "en_US" }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },
  themeConfig: {
    logo: "/assets/icon.svg",
    nav: [
      { text: "Guide", link: "/guide" },
      {
        text: "pi.dev",
        link: "https://pi.dev/packages/@ygncode/pi-web?name=pi-web",
      },
    ],
    sidebar: [
      { text: "Welcome to pi-web", link: "/guide" },
      { text: "Why pi-web?", link: "/why" },
      { text: "Install", link: "/install" },
      { text: "Personal AI Assistant", link: "/personal-assistant" },
      { text: "Keyboard Shortcuts", link: "/keyboard-shortcuts" },
      { text: "LLM Debugging", link: "/llm-debug" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    // GitHub lives in the nav as a "Star" call-to-action (GitHubStar.vue), so no
    // duplicate social icon here.
    search: { provider: "local" },
    footer: {
      message:
        "pi-web is a community pi package — not official, and not affiliated with pi itself. Released under the MIT License.",
      copyright: "pi-web — remote-control your pi coding agent.",
    },
  },
});
