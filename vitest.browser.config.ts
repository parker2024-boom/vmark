import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { LIVENESS_TIMEOUT_MS, TEST_DEFINES, sourceAliases, suffixGlob } from "./vitest.shared.ts";

/**
 * Browser test tier — the terminal input gate path cannot be verified in jsdom
 * (Q1: jsdom drains microtasks as [L1,L2,microtask] not [L1,microtask,L2]; Q3:
 * src/test/setup.ts globally mocks @xterm/xterm). These tests run in REAL WebKit
 * against the REAL xterm.js, dispatching recorded event sequences and asserting
 * exact bytes reaching a recording fake PTY.
 *
 * Deliberately NOT wired into `check:all` (jsdom): run with `pnpm test:browser`.
 * No `src/test/setup.ts` — that mock is exactly what this tier exists to avoid.
 */

/**
 * Ends the run when Vite re-optimizes dependencies mid-run. The reload that
 * follows can drop the running test file, and the tier then hangs until the CI
 * job timeout; exiting here names the cause at once. Vitest installs its own
 * `customLogger`, so this wraps the final resolved logger instead — Vite's
 * per-environment loggers forward to it at call time.
 */
function failOnMidRunReoptimization(): Plugin {
  return {
    name: "vmark:fail-on-mid-run-reoptimization",
    configResolved(config) {
      const { logger } = config;
      const info = logger.info.bind(logger);
      logger.info = (msg, options) => {
        info(msg, options);
        if (msg.includes("optimized dependencies changed. reloading")) {
          logger.error(
            "[webkit tier] Vite discovered a dependency mid-run. Rerun with DEBUG=vite:deps to name it, " +
              "then add it to optimizeDeps.include in vitest.browser.config.ts.",
          );
          process.exit(1);
        }
      };
    },
  };
}

export default defineConfig({
  plugins: [failOnMidRunReoptimization()],
  // The build-time constants the app reads (see TEST_DEFINES).
  define: TEST_DEFINES,
  test: {
    globals: true,
    // `*.webkit.test.ts` = real-WebKit tier. NOT `*.browser.test.ts` — that
    // suffix already means "tests for the embedded-browser FEATURE" and those
    // are ordinary jsdom tests.
    include: [suffixGlob("src", "webkit")],
    // A liveness bound, as in every other tier (see `LIVENESS_TIMEOUT_MS`):
    // this tier boots a real browser and transforms real modules, so vitest's
    // 5000ms default measured how busy the machine was.
    testTimeout: LIVENESS_TIMEOUT_MS,
    hookTimeout: LIVENESS_TIMEOUT_MS,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "webkit" }],
    },
  },
  // Vite must never discover a dependency mid-run: a discovery re-bundles and
  // reloads the page, and the reload silently drops the test file that was
  // running (the job then hangs instead of failing). CI starts cold whenever
  // the lockfile changes, so a warm local cache hides the defect. So the
  // startup scan crawls every test file (`entries`), and `include` names what
  // that crawl cannot see: modules a dependency imports lazily, such as the
  // grammars `@codemirror/language-data` loads on demand.
  optimizeDeps: {
    entries: [suffixGlob("src", "webkit")],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-dev-runtime",
      "react-i18next",
      "react-router-dom",
      "alfaaz",
      "smol-toml",
      "codemirror-lang-mermaid",
      "@codemirror/lang-css",
      "@codemirror/lang-go",
      "@codemirror/lang-html",
      "@codemirror/lang-javascript",
      "@codemirror/lang-python",
      "@codemirror/lang-rust",
      "@codemirror/lang-xml",
      "@codemirror/lang-yaml",
      "@codemirror/legacy-modes/mode/lua",
      "@codemirror/legacy-modes/mode/ruby",
      "@codemirror/legacy-modes/mode/shell",
    ],
  },
  resolve: {
    alias: sourceAliases(import.meta.dirname),
  },
});
