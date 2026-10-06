import footnote from "markdown-it-footnote";
import { vitepressMarkmapPreview } from "vitepress-markmap-preview";
import type { UserConfig } from "vitepress";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { slugify } from "./slugify";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../../../package.json"), "utf-8")
);

/**
 * The CJK demo runs the app's formatter rule chain, whose one import outside
 * the formatter is the app logger `@/utils/debug` — and that reaches
 * `@tauri-apps/plugin-log`, which cannot load in a web page. This plugin
 * answers exactly that specifier with a console-only module; every other `@/`
 * import still fails the site build. scripts/check-cjk-demo-parity.mjs fails a
 * PR whose rule chain gains an import this does not stand in for.
 */
const APP_LOGGER = "@/utils/debug";
const APP_LOGGER_STAND_IN = "\0vmark-app-logger-stand-in";

function appLoggerStandIn() {
  return {
    name: "vmark-app-logger-stand-in",
    enforce: "pre" as const,
    resolveId: (id: string) => (id === APP_LOGGER ? APP_LOGGER_STAND_IN : null),
    load: (id: string) =>
      id === APP_LOGGER_STAND_IN
        ? 'export const cjkFmtWarn = (...args) => console.warn("[CJK Formatter]", ...args);'
        : null,
  };
}

export const shared: UserConfig = {
  title: "VMark",
  description: "The plain-text workspace where humans and AI collaborate",

  vite: {
    define: {
      __VMARK_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [appLoggerStandIn()],
  },
  lastUpdated: true,
  appearance: false, // We use our own theme switcher

  markdown: {
    anchor: { slugify },
    config: (md: any) => {
      md.use(footnote);
      vitepressMarkmapPreview(md);
    },
  },

  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
    ["meta", { name: "theme-color", content: "#4a6fa5" }],
    ["meta", { name: "mobile-web-app-capable", content: "yes" }],
    [
      "meta",
      { name: "apple-mobile-web-app-status-bar-style", content: "black" },
    ],
  ],

  mermaid: {
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  },
};
