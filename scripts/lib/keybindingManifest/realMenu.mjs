/**
 * The REAL Rust menu builder's accelerators: every `accel("<menu-id>", …)`
 * call site in `src-tauri/src/menu/localized/*.rs`, static or
 * platform-conditional.
 *
 * Purpose: the keybinding gate compares the definitions against what the
 * native menu actually binds, not only against the contract mirror in
 * `localized.test.rs`; this module is that read, and it fails closed on any
 * call shape it does not understand.
 *
 * @coordinates-with scripts/check-keybinding-manifest.mjs — the CLI that runs the legs
 * @coordinates-with scripts/lib/rustSource.mjs — the one Rust tokenizer these scans go through
 * @module scripts/lib/keybindingManifest/realMenu
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { rustCode, rustSpans } from "../rustSource.mjs";
import { ROOT, LOCALIZED_DIR, fail, readOrDie } from "./context.mjs";

/**
 * Scan every `accel(...)` call site in a real menu-builder source. Ports the
 * paren-depth scanner from `localized.test.rs::scan_accel_calls` so nested
 * `cfg!(...)` parens don't end a call early. Returns an array of
 * `{ id, accel }` where `accel` is either a string (static literal) or
 * `{ mac, other }` (the `if cfg!(target_os = "macos") { … } else { … }` form).
 *
 * Comments and literals come from `lib/rustSource.mjs`'s `rustSpans` — the
 * repo's ONE Rust tokenizer — rather than from a loop in this file. The loop
 * that lived here was a second implementation of the same grammar and had
 * drifted exactly as a copy does: it closed a NESTED block comment at the first
 * `*​/`, knew nothing of raw strings (`r#"a"b"#`, whose unescaped quote opened
 * an ordinary string), and did not recognise char literals at all — so a single
 * `'"'` anywhere in a menu file sent it into string mode and every later
 * `accel(...)` disappeared from the check with nothing to fail on.
 * Skipping a span is also what keeps a commented-out or
 * quoted call from being read as a real one, which is the promise this scan
 * already made.
 */
function scanAccelCalls(src, rel) {
  const spans = new Map();
  for (const span of rustSpans(src)) spans.set(span.start, span);
  const calls = [];
  let i = 0;
  while (i < src.length) {
    const span = spans.get(i);
    // A comment or a literal is never a call site.
    if (span) {
      i = span.end;
      continue;
    }
    // Require a call boundary: the char before `accel` must not be an identifier
    // char (so `AccelFn`, `my_accel(` etc. never match).
    if (!src.startsWith("accel(", i) || /[A-Za-z0-9_]/.test(i > 0 ? src[i - 1] : " ")) {
      i += 1;
      continue;
    }
    let j = i + "accel(".length;
    let depth = 1;
    const lits = [];
    const litSpans = [];
    while (depth > 0) {
      // An unterminated comment or literal runs to end of input (rustSpans), so
      // this is also the fail-closed exit for a file that no longer parses.
      if (j >= src.length) fail(`${rel}: unterminated accel(...) call — fail closed`);
      const inner = spans.get(j);
      if (inner) {
        if (inner.kind === "string") {
          lits.push(inner.value);
          litSpans.push([inner.start, inner.end]);
        }
        j = inner.end;
        continue;
      }
      const c = src[j];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      j += 1;
    }
    if (lits.length === 2) {
      calls.push({ id: lits[0], accel: lits[1] });
    } else if (lits.length === 4) {
      if (lits[1] !== "macos") {
        fail(`${rel}: accel("${lits[0]}", …) has an unexpected cfg! target "${lits[1]}" (expected "macos")`);
      }
      // Four literals with "macos" second is NOT enough to know which branch is
      // which: `if !cfg!(target_os = "macos") { A } else { B }` has exactly the
      // same literals in the same order and means the opposite, and so does a
      // shape with the branches swapped. Check the TEXT BETWEEN
      // the literals — over code, so a comment between arguments is whitespace.
      const between = (a, b) => rustCode(src.slice(litSpans[a][1], litSpans[b][0]), { keepStrings: true });
      const bad =
        !/^\s*,\s*if\s+cfg!\s*\(\s*target_os\s*=\s*$/.test(between(0, 1)) ||
        !/^\s*\)\s*\{\s*$/.test(between(1, 2)) ||
        !/^\s*\}\s*else\s*\{\s*$/.test(between(2, 3));
      if (bad) {
        fail(
          `${rel}: accel("${lits[0]}", …) is not the platform-conditional shape this gate reads ` +
            '(`if cfg!(target_os = "macos") { <macOS> } else { <other> }`). A negated cfg!, a ' +
            "swapped pair of branches or a nested conditional carries the same four literals and " +
            "means something else, so the gate fails closed rather than assuming the polarity.",
        );
      }
      calls.push({ id: lits[0], accel: { mac: lits[2], other: lits[3] } });
    } else {
      fail(
        `${rel}: accel(…) call for "${lits[0] ?? "?"}" has ${lits.length} string ` +
          `literals (expected 2 for a static accel or 4 for the macOS/else form). ` +
          `The gate fails closed on any unrecognised accel(...) shape.`,
      );
    }
    i = j;
  }
  return calls;
}

/**
 * Parse every real menu-builder source (`localized/*.rs`, excluding `*.test.rs`)
 * into `{ realDefault, realPlatform, files }`:
 *   - `realDefault: Map<id, accelString>` for static `accel("id", "…")` sites, and
 *   - `realPlatform: Map<id, { mac, other }>` for the platform-conditional form.
 * On a duplicate id (e.g. `preferences`/`quit`/`save-all-quit` appear in both the
 * macOS App menu and the non-macOS File-menu tail) the values MUST agree — a
 * conflict fails the gate.
 */
export function parseRealMenu() {
  const realDefault = new Map();
  const realPlatform = new Map();
  let files;
  try {
    files = readdirSync(join(ROOT, LOCALIZED_DIR)).filter(
      (f) => f.endsWith(".rs") && !f.endsWith(".test.rs"),
    );
  } catch (err) {
    fail(`cannot read ${LOCALIZED_DIR}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (files.length === 0) fail(`${LOCALIZED_DIR}: no menu-builder .rs sources found`);
  for (const file of files.sort()) {
    const rel = `${LOCALIZED_DIR}/${file}`;
    const src = readOrDie(rel);
    for (const { id, accel } of scanAccelCalls(src, rel)) {
      if (typeof accel === "string") {
        const prior = realDefault.get(id);
        if (prior !== undefined && prior !== accel) {
          fail(`${rel}: accel("${id}", …) = ${JSON.stringify(accel)} conflicts with an earlier site ${JSON.stringify(prior)}`);
        }
        if (realPlatform.has(id)) {
          fail(`${rel}: "${id}" is a static accel here but platform-conditional elsewhere`);
        }
        realDefault.set(id, accel);
      } else {
        const prior = realPlatform.get(id);
        if (prior !== undefined && (prior.mac !== accel.mac || prior.other !== accel.other)) {
          fail(`${rel}: platform accel("${id}", …) conflicts with an earlier site`);
        }
        if (realDefault.has(id)) {
          fail(`${rel}: "${id}" is platform-conditional here but a static accel elsewhere`);
        }
        realPlatform.set(id, accel);
      }
    }
  }
  if (realDefault.size === 0) fail(`${LOCALIZED_DIR}: parsed zero static accel(...) sites`);
  return { realDefault, realPlatform };
}
