/**
 * How the design-token gate reads the tree: glob to regular files, read with a
 * vanished file treated as absent, blank comments before pattern scans, and
 * collect custom properties defined from JS.
 *
 * @coordinates-with scripts/check-design-tokens.mjs — the CLI, which re-exports these
 * @coordinates-with scripts/lib/designTokenIntegrity.mjs — reads the tree through these
 * @module scripts/lib/designTokenScan
 */
import { readFileSync, globSync, statSync } from "node:fs";

/**
 * Replace every CSS comment with spaces of the same length.
 *
 * The pattern checks below scan for things that look like declarations, and a
 * comment is prose. `#1376` in a comment citing a GitHub issue was reported as
 * a "Hardcoded hex color" with the advice "Use CSS variable token instead" —
 * advice that cannot be followed, on a line that declares nothing. rule 31
 * already records this false-positive shape for the sibling ui-tokenize tool.
 *
 * SPACES rather than deletion: the checks derive a line number by counting
 * newlines before the match offset, so removing text would slide every
 * subsequent violation onto the wrong line. Newlines inside the comment are
 * preserved for the same reason.
 */
export function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (s) =>
    s.replace(/[^\n]/g, " "),
  );
}

/**
 * CSS custom properties DEFINED from JS in `source`: `setProperty("--x", …)`
 * and object-literal keys (`"--x": value`).
 *
 * The object-key pattern requires a COLON. A trailing COMMA must not count:
 * `"--x",` is an ARRAY ELEMENT — a var being *read*, not defined. Accepting it
 * made this gate miss the exact thing it exists to catch: export/themeSnapshot.ts
 * lists "--spacing-1/2/3" among the vars it snapshots via getPropertyValue,
 * which marked that whole family "defined" while nothing declared it, and 133
 * padding/margin/gap declarations across 13 components were silently dropped
 * while this check stayed green.
 */
export function collectJsDefinedVars(source) {
  const names = new Set();
  for (const m of source.matchAll(/setProperty\(\s*["'`](--[A-Za-z0-9-]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/["'`](--[A-Za-z0-9-]+)["'`]\s*:/g)) names.add(m[1]);
  return names;
}

/**
 * `globSync` restricted to regular files.
 *
 * Vitest's browser runner writes screenshot artifacts into a `__screenshots__`
 * directory beside the test, named after the test FILE — so a directory whose
 * name ends in `.ts` exists after any `*.webkit.test.ts` failure, and those
 * directories are gitignored, i.e. expected on a developer machine. Feeding
 * it to `readFileSync` threw an unhandled `EISDIR` and killed this gate with a
 * raw Node stack trace, which reads as "the token checker is broken" rather than
 * "you have a leftover artifact".
 *
 * @param {string} pattern
 * @returns {string[]}
 */
export function globFiles(pattern) {
  return globSync(pattern).filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      // Raced with a delete, or a broken symlink. Not ours to read either way.
      return false;
    }
  });
}

/**
 * `readFileSync` with `globFiles`' race contract carried through to the read:
 * the stat filter above cannot close the window between glob and read, and a
 * scanned file CAN vanish inside it — `gha-tdd-guard.test.mjs` writes probe
 * `*.test.ts` files into `src/lib/browser/` and deletes them while the gates
 * tier runs this CLI against the real tree (the same transient that gave
 * `check-scripts-parity` a ~25% flake rate before its single-snapshot fix).
 * A vanished file is "not ours to read", exactly like a raced delete at stat
 * time; anything other than ENOENT still throws.
 *
 * @param {string} file
 * @returns {string | null} contents, or null when the file no longer exists
 */
export function readScannedFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
