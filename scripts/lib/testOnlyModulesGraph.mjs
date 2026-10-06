/**
 * The production graph the test-only-modules gate measures: knip's production
 * config, the checks that the graph definition can be trusted, and knip's JSON
 * report turned into a validated list of unreachable files.
 *
 * Purpose: everything that talks to knip or to `scripts/knip-production.json`
 * lives here; the identity baseline lives in `testOnlyModulesBaseline.mjs` and
 * the CLI (with the test-support convention) in the gate itself. Each function
 * fails closed — the reasons are in the gate's header.
 *
 * @coordinates-with scripts/check-test-only-modules.mjs — the gate (CLI) that re-exports this
 * @coordinates-with scripts/knip-production.json — the production graph definition
 * @module scripts/lib/testOnlyModulesGraph
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const CONFIG_PATH = "scripts/knip-production.json";

/**
 * Unused-file paths out of knip's JSON reporter output; both shapes it has
 * used (a root `files` array, and knip 6's `issues[].files[]`). Every record
 * is validated — a string, or an object with a string `name` — because a
 * report of unknown shape read as empty would be a measurement of nothing
 * that looks like a clean tree.
 */
export function parseKnipFiles(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`knip did not return JSON: ${err.message}\n--- output starts ---\n${String(jsonText).slice(0, 400)}`);
  }
  if (!parsed || typeof parsed !== "object" || (!Array.isArray(parsed.issues) && !Array.isArray(parsed.files))) {
    throw new Error("knip JSON has neither an `issues` array nor a `files` array");
  }
  const names = new Set();
  const record = (f, where) => {
    if (typeof f === "string" && f !== "") return names.add(f);
    if (f && typeof f === "object" && typeof f.name === "string" && f.name !== "") return names.add(f.name);
    throw new Error(`knip JSON: ${where} holds a file record of unknown shape: ${JSON.stringify(f)}`);
  };
  for (const f of parsed.files ?? []) record(f, "files[]");
  // EVERY issue record must carry a `files` array. Accepting one without it
  // meant a reporter-schema change could drop findings while the rest of the
  // report kept the run looking valid — a partial measurement that reads as a
  // clean tree. Measured against knip's real production output:
  // 58 of 58 records carry it, so this refuses nothing that
  // ships. The pre-knip-6 shape (a ROOT `files` array) is still accepted, and
  // then `issues` is not the carrier.
  const rootFiles = Array.isArray(parsed.files);
  (parsed.issues ?? []).forEach((issue, i) => {
    if (!issue || typeof issue !== "object") throw new Error(`knip JSON: issues[${i}] is not an issue record`);
    if (!Array.isArray(issue.files)) {
      if (rootFiles) return;
      throw new Error(
        `knip JSON: issues[${i}] carries no \`files\` array (keys: ${Object.keys(issue).join(", ") || "none"}) — ` +
          "a report this gate only half understands is not a measurement",
      );
    }
    for (const f of issue.files) record(f, `issues[${i}].files[]`);
  });
  return [...names].map((n) => n.replace(/\\/g, "/")).sort();
}

/** Production entry patterns declared by the config: `{ dir, pattern, isGlob }`, pattern relative to `dir`. */
export function productionEntries(config) {
  const out = [];
  for (const [dir, ws] of Object.entries(config.workspaces ?? {})) {
    for (const pattern of ws.entry ?? []) {
      if (!pattern.endsWith("!")) continue;
      const bare = pattern.slice(0, -1);
      // The character class must match what globToRegExp UNDERSTANDS: `[`/`]`
      // are refused there, so classifying them as glob syntax here would turn a
      // literal path into a glob that matches nothing.
      out.push({ dir, pattern: bare, isGlob: /[*?{}]/.test(bare) });
    }
  }
  return out;
}

/**
 * knip's entry-glob dialect as a RegExp over a `/`-joined relative path: `*`,
 * `**`, `?` and `{a,b}` — and NOTHING else, stated by refusing the rest.
 *
 * An unmatched `{` set `i = pattern.indexOf("}", i)` to -1, the loop's `i++`
 * made it 0, and the scan restarted from the beginning: a HANG, in a gate, on
 * a one-character typo. A bracket expression is refused for the
 * matching reason — the converter escapes `[` and `]` as literals, so a
 * `[abc]` pattern would be classified as a glob and then matched literally,
 * quietly matching nothing.
 */
export function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") { re += "(?:.*)"; i++; if (pattern[i + 1] === "/") { re += "\\/?"; i++; } }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) throw new Error(`knip-production.json: unterminated \`{\` in the entry pattern ${JSON.stringify(pattern)}`);
      re += `(?:${pattern.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    }
    else if (c === "[" || c === "]") throw new Error(`knip-production.json: bracket expressions are not supported in the entry pattern ${JSON.stringify(pattern)} — this converter would match them literally`);
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Files under `root/dir` matching a knip entry glob (vendored and build dirs skipped). */
export function globMatches(root, dir, pattern) {
  const re = globToRegExp(pattern);
  const skip = new Set(["node_modules", "dist", "target", ".git", "coverage"]);
  const hits = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else if (re.test(childRel)) hits.push(childRel);
    }
  };
  const base = join(root, dir);
  if (existsSync(base)) walk(base, "");
  return hits.sort();
}

/** Every entry/project pattern must carry the `!` marker, or production mode has no graph. */
export function unmarkedPatterns(config) {
  const out = [];
  for (const [dir, ws] of Object.entries(config.workspaces ?? {})) {
    for (const key of ["entry", "project"]) {
      for (const pattern of ws[key] ?? []) if (!pattern.endsWith("!")) out.push(`${dir}: ${key} ${pattern}`);
    }
  }
  return out;
}

export function readConfig(root = ROOT) {
  return JSON.parse(readFileSync(join(root, CONFIG_PATH), "utf8"));
}

/** Throws when the production graph cannot be trusted; the gate exits 2 on it. */
export function assertGraphDefinition(config, root = ROOT) {
  const unmarked = unmarkedPatterns(config);
  if (unmarked.length) {
    throw new Error(`knip-production.json: patterns without the \`!\` production marker (the graph would be empty):\n  ${unmarked.join("\n  ")}`);
  }
  const entries = productionEntries(config);
  if (!entries.some((e) => !e.isGlob)) throw new Error("knip-production.json declares no literal production entry file");
  // A literal entry must exist; a glob entry must match at least one file —
  // an unmatched root (`scripts/*.mjs` after a rename) silently shrinks the
  // graph, and everything only that root reached turns into a finding.
  const missing = entries
    .filter((e) => (e.isGlob ? globMatches(root, e.dir, e.pattern).length === 0 : !existsSync(join(root, e.dir, e.pattern))))
    .map((e) => `${e.dir === "." ? "" : `${e.dir}/`}${e.pattern}${e.isGlob ? " (glob matches no file)" : ""}`);
  if (missing.length) {
    throw new Error(`production entry file(s) missing on disk — the graph would report everything unreachable:\n  ${missing.join("\n  ")}`);
  }
}

export function runKnip(root = ROOT, exec = execFileSync) {
  const args = ["exec", "knip", "--production", "--config", CONFIG_PATH, "--include", "files", "--reporter", "json", "--no-progress"];
  let status = 0;
  let stdout;
  try {
    stdout = exec("pnpm", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // knip's exit codes: 1 = issues found (the normal path here; stdout is the
    // report), 2 = knip itself failed (bad config, crash). Only a report from
    // exit 1 is a report — JSON-shaped stdout from a crash is still a crash.
    if (err.status !== 1 || typeof err.stdout !== "string" || !err.stdout.trim().startsWith("{")) {
      throw new Error(`knip failed to run (exit ${err.status ?? "?"}): ${err.stderr || err.message}`);
    }
    status = 1;
    stdout = err.stdout;
  }
  // The exit status and the report must agree: "issues found" with no unused
  // file listed (or "clean" with one) is a report this gate did not ask for —
  // a reporter or filter drift — and is not a measurement.
  const files = parseKnipFiles(stdout);
  if (status === 1 && files.length === 0) throw new Error("knip exited 1 (issues found) but its JSON report lists no unused file — an inconsistent report is not a measurement");
  if (status === 0 && files.length > 0) throw new Error(`knip exited 0 (no issues) but its JSON report lists ${files.length} unused file(s) — an inconsistent report is not a measurement`);
  // The VALIDATED list, not the raw text. Returning the text made `measure()`
  // parse the same report a second time, so the shape this function has already
  // checked was re-derived by a second call that could drift from it — two
  // readings of one measurement.
  return files;
}
