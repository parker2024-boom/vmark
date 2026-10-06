/**
 * Which `#[tauri::command]` functions can reach a window builder, and which of
 * them run on the main thread — the decision half of the window-thread gate.
 *
 * Purpose: given the fns `windowThreadParse.mjs` produced, walk call edges by
 * name (visibility-aware) from every builder site and report the synchronous
 * commands that reach one. The reasoning behind each rule is in the header of
 * `scripts/check-window-creation-thread.mjs`.
 *
 * @coordinates-with scripts/check-window-creation-thread.mjs — the gate (CLI) that re-exports this
 * @coordinates-with scripts/lib/windowThreadParse.mjs — produces the fns walked here
 * @module scripts/lib/windowThreadReach
 */

/** The call that actually creates a native window + webview. */
export const WINDOW_BUILDER = "WebviewWindowBuilder::new";

/**
 * Every constructor that hands tao/wry a window to create, and therefore every
 * seed for the reachability walk.
 *
 * ONE hardcoded `WebviewWindowBuilder::new` substring was the whole detector,
 * and it fails OPEN in a way `seedCount` cannot see: the existing sites keep
 * the count non-zero, so a NEW site built through `WindowBuilder::new` (a
 * window with no webview), `WebviewBuilder::new` (a webview added to an
 * existing window) or `…::from_config` is simply not a seed, and every command
 * reaching it passes. A turbofish between the type and the
 * constructor (`WebviewWindowBuilder::<R>::new`) defeated the substring too.
 *
 * The word boundary matters: `\bWindowBuilder` must not match inside
 * `WebviewWindowBuilder`, or the two names would double-count the same site.
 */
const BUILDER_TYPES = ["WebviewWindowBuilder", "WindowBuilder", "WebviewBuilder"];
const BUILDER_CTORS = ["new", "from_config"];
export const WINDOW_BUILDER_CALL = new RegExp(
  `\\b(?:${BUILDER_TYPES.join("|")})\\s*(?:::\\s*<[^>]*>\\s*)?::\\s*(?:${BUILDER_CTORS.join("|")})\\s*\\(`,
);

/**
 * An ALIAS import of a window builder (`use tauri::WebviewWindowBuilder as W;`).
 *
 * The gate resolves calls by NAME, so it cannot follow one. Rather than fail
 * open on the rename, it refuses: the alias is reported and the gate exits
 * non-zero, which is the loud half of the same property `seedCount` protects.
 */
export const BUILDER_ALIAS = new RegExp(
  `\\b(?:${BUILDER_TYPES.join("|")})\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`,
);

/** Per-command opt-out; the trailing reason is required. */
export const OK_MARKER = /\/\/\s*window-thread-ok:\s*(\S.*)$/m;
const BARE_MARKER = /\/\/\s*window-thread-ok:?\s*$/m;

/**
 * Does `caller` call `callee`, as far as names can tell?
 *
 * Two forms, and the difference is the second false-positive class this gate
 * has had to answer. Within one FILE any spelling counts: the author can see
 * both definitions, and a local method and a local free function sharing a
 * name is not how this goes wrong. ACROSS files a receiver call — `x.name(`
 * — does not count, because the receiver decides which type's method runs and
 * this scan does not know types. `pdf_export::renderer::sink` gained a
 * `pub(super) fn settle` while `browser::nav_kvo_macos` calls `owned.settle(…)`
 * on something else entirely; with `\b` those two were ONE edge, and through
 * it the reachable set grew to include `read_workspace_config`,
 * `update_recent_files` and five more commands that touch no window at all.
 * Seven findings, every one false, and the "fix" they asked for was making
 * seven unrelated commands async — which `AGENTS.md` records as its own
 * hazard, since going async removes serialization the blocking IPC loop
 * provided.
 *
 * A path-qualified call (`module::name(`, `Type::name(`) still counts across
 * files: `::` is not a receiver. What is given up is a window-creating METHOD
 * reached from another file through a value — none exists here (every builder
 * site is a free function, and `check-window-creation-thread.test.mjs` pins
 * that all seven #1301 commands are still caught by this rule).
 */
/**
 * Does `caller` bind `name` itself — as a parameter, or as a `let`?
 *
 * Either shadows a crate item of the same name for the whole body, so a bare
 * `name(...)` there is the LOCAL callable, not the item.
 */
function bindsLocally(caller, name) {
  const param = new RegExp(`(^|[(,\\s])${name}\\s*:`);
  const binding = new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\b`);
  return param.test(caller.params) || binding.test(caller.body);
}

function callsByName(caller, callee) {
  if (caller.file === callee.file) {
    return new RegExp(`\\b${callee.name}\\s*(?:::\\s*<[^>]*>\\s*)?\\(`).test(caller.body);
  }
  const qualified = new RegExp(`::\\s*${callee.name}\\s*(?:::\\s*<[^>]*>\\s*)?\\(`);
  // A caller that BINDS the name locally cannot reach the crate item through a
  // bare call — Rust resolves the binding — so only a path-qualified spelling
  // counts. This is the THIRD instance of one class (after bare-name and
  // receiver calls), and it arrived the moment an unrelated refactor gave the
  // crate a `pub(crate) fn register`: `dock_recent.rs`'s `try_register_with`
  // takes a closure PARAMETER called `register` and calls `register(path)`, so
  // the whole dock-recent chain became "reachable" from a window builder and
  // `register_dock_recent` was reported as a Windows deadlock it cannot have.
  // Nothing is given up: a shadowing body that really does mean the crate item
  // has to write `module::name(...)`, which `qualified` still matches.
  if (bindsLocally(caller, callee.name)) return qualified.test(caller.body);
  return new RegExp(`(?<![.\\w])${callee.name}\\s*(?:::\\s*<[^>]*>\\s*)?\\(`).test(caller.body);
}

/** Does this body construct a window? */
export const buildsWindow = (fn) => WINDOW_BUILDER_CALL.test(fn.body);

/** Ids of every fn that can reach a window builder, transitively. */
export function reachableWindowCreators(fns) {
  const reach = new Set(fns.filter(buildsWindow).map((f) => f.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const caller of fns) {
      if (reach.has(caller.id)) continue;
      for (const callee of fns) {
        if (!reach.has(callee.id)) continue;
        // A private callee is only visible inside its own module (= its file).
        if (!callee.crateVisible && callee.file !== caller.file) continue;
        if (callsByName(caller, callee)) { reach.add(caller.id); changed = true; break; }
      }
    }
  }
  return reach;
}

/** Commands that create a window on the main thread, plus bare-marker abuses. */
export function findings(fns) {
  const reach = reachableWindowCreators(fns);
  const violations = [];
  const bareMarkers = [];
  for (const fn of fns) {
    if (BARE_MARKER.test(fn.rawBody) && !OK_MARKER.test(fn.rawBody)) bareMarkers.push(fn);
    if (!fn.isCommand || !reach.has(fn.id)) continue;
    if (fn.isAsync || /\basync\b/.test(fn.attrArgs)) continue;
    if (OK_MARKER.test(fn.rawBody)) continue;
    violations.push(fn);
  }
  return { violations, bareMarkers, seedCount: fns.filter(buildsWindow).length };
}
