#!/usr/bin/env node
/**
 * Window-creation threading gate — `pnpm lint:window-thread`, in `check:static`.
 *
 * A `#[tauri::command]` WITHOUT `async` is `ExecutionContext::Blocking`: the
 * generated wrapper runs the body inline on the thread that handed Tauri the
 * IPC message. On Windows that thread is inside WebView2's
 * `add_WebMessageReceived` COM callback (wry `webview2/mod.rs`), and creating a
 * webview from inside a WebView2 callback is the reentrancy case WebView2
 * forbids. Both upstreams say so in their own source:
 *
 *   tauri `WebviewWindowBuilder::new` — "On Windows, this function deadlocks
 *     when used in a synchronous command and event handlers … You should use
 *     `async` commands and separate threads when creating windows."
 *   tauri-runtime-wry `create_webview` — "this must be called from a separate
 *     thread, otherwise the channel will introduce a deadlock."
 *
 * This is a WINDOWS-ONLY hang with NO macOS symptom, so nothing a maintainer
 * runs locally can see it: it compiles, it passes every other gate, and it
 * ships. #1301 and #1302 are that failure — the Settings window opened from
 * the status bar (a frontend `invoke`) froze the app, while the SAME window
 * opened from the native menu worked, because a menu click arrives through
 * tao's event loop rather than through a WebView2 callback. That asymmetry is
 * the fingerprint of this bug class.
 *
 * The property: every `#[tauri::command]` that can reach a window builder —
 * `WebviewWindowBuilder`, `WindowBuilder` or `WebviewBuilder`, via `new` or
 * `from_config`, turbofish and all — must run off the main thread: `async fn`,
 * or `#[tauri::command(async)]` (which spawns even a sync body onto the
 * runtime). A builder imported under an ALIAS is refused rather than missed,
 * because this gate resolves calls by name and cannot follow one.
 *
 * Measured at ZERO once #1301 was fixed (7 commands converted), so it ships
 * zero-tolerance with NO baseline. Do not add one: a baseline here would be a
 * list of commands known to hang Windows.
 *
 * WHY REACHABILITY IS VISIBILITY-AWARE. Resolving calls by bare name reports
 * 15 findings on this crate, 8 of them false: the seed set is six private
 * helpers, two of them named `start` and two `start_print`, and those names are
 * written in modules that have nothing to do with windows. Visibility settles it
 * without a name resolver — a private `fn` is callable only from its own module,
 * i.e. its own file. With that one rule the same scan reports 7, all real.
 *
 * ESCAPE HATCH. A command that hands window creation to a spawned task is
 * already off the main thread and is not a defect. Mark it
 * `// window-thread-ok: <reason>` on a line inside the command body. The reason
 * is REQUIRED — a bare marker is rejected, the same rule the i18n allowlist and
 * `command-error-ok` carry.
 *
 * @coordinates-with src-tauri/src/window_manager/ — the window builders
 * @coordinates-with scripts/lib/windowThreadParse.mjs — Rust source → fn items
 * @coordinates-with scripts/lib/windowThreadReach.mjs — reachability and findings
 * @module scripts/check-window-creation-thread
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { isMainModule } from "./lib/isMainModule.mjs";
import { parseFns, stripComments } from "./lib/windowThreadParse.mjs";
import { BUILDER_ALIAS, WINDOW_BUILDER, findings } from "./lib/windowThreadReach.mjs";

export { parseFns, stripComments } from "./lib/windowThreadParse.mjs";
export {
  WINDOW_BUILDER,
  WINDOW_BUILDER_CALL,
  BUILDER_ALIAS,
  OK_MARKER,
  buildsWindow,
  reachableWindowCreators,
  findings,
} from "./lib/windowThreadReach.mjs";

function main() {
  // A missing `src-tauri/src` makes `find` exit non-zero. Swallowing that into
  // an empty list is safe ONLY because the empty case below is a hard failure —
  // never a pass. Letting the exception escape would exit 1 with a stack trace,
  // which reads as a finding rather than as a broken gate.
  let found = "";
  try {
    found = execFileSync("find", ["src-tauri/src", "-type", "f", "-name", "*.rs"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    found = "";
  }
  const files = found
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => !/\.test\.rs$/.test(f));

  if (files.length === 0) {
    console.error("no Rust sources found under src-tauri/src — refusing to pass vacuously");
    process.exit(64);
  }

  // An ALIASED builder import renames the very call this gate resolves by name,
  // so it would find nothing and say nothing. Refuse instead of failing open.
  const aliased = [];
  for (const f of files) {
    const m = BUILDER_ALIAS.exec(stripComments(readFileSync(f, "utf8")));
    if (m) aliased.push(`${f}: imported as \`${m[1]}\``);
  }
  if (aliased.length) {
    console.error(
      "a window builder is imported under an ALIAS — this gate resolves calls by name and\n" +
        "cannot follow one, so it would report green while the aliased site went unchecked:\n",
    );
    for (const a of aliased) console.error(`  ${a}`);
    console.error("\nImport the builder under its own name, or teach this gate the alias.");
    process.exit(64);
  }

  const fns = files.flatMap((f) => parseFns(f, readFileSync(f, "utf8")));
  const { violations, bareMarkers, seedCount } = findings(fns);

  if (seedCount === 0) {
    console.error(
      `no function calls ${WINDOW_BUILDER} (nor any other window builder) — the ` +
        "window-creation primitive moved; update this gate",
    );
    process.exit(64);
  }

  if (bareMarkers.length) {
    console.error("window-thread-ok markers with no reason (a reason is required):\n");
    for (const f of bareMarkers) console.error(`  ${f.file}:${f.line}  ${f.name}`);
    process.exit(1);
  }

  if (violations.length) {
    console.error(
      "Tauri commands that create a window on the main thread (deadlocks on Windows):\n",
    );
    for (const f of violations) console.error(`  ${f.file}:${f.line}  ${f.name}`);
    console.error(
      "\nMake each one `#[tauri::command(async)]` (or `async fn`) so the body runs off\n" +
        "the main thread. See the header of scripts/check-window-creation-thread.mjs.",
    );
    process.exit(1);
  }

  console.log(
    `window-creation threading: OK (${seedCount} builder site(s), every reaching command is async)`,
  );
}

if (isMainModule(import.meta.url)) main();
