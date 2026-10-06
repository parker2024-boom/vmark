#!/usr/bin/env node
/**
 * Blocking RustSec gate with a reviewed acceptance list, enforced both ways.
 *
 * Purpose: make every `cargo audit` finding either fixed or written down with
 * the reason it is tolerated, and make the written-down ones expire.
 *
 * Why it exists: bare `cargo audit` exits non-zero for vulnerabilities only.
 * Unmaintained, unsound and yanked crates are WARNINGS — printed, exit 0 — so
 * the job was green over nine of them with no record of whether anyone had
 * looked. And the two vulnerabilities it did tolerate were `--ignore` flags in
 * the workflow, which is a one-way acceptance: the flags stayed after the
 * dependency was upgraded past the fix, because nothing fails when an ignored
 * advisory stops applying.
 *
 * The rules, the same as the npm gate's:
 *   - a finding that is NOT in the acceptance file fails;
 *   - an acceptance whose finding is GONE fails, so it cannot outlive the risk
 *     it was granted for;
 *   - an acceptance with no `reason` fails;
 *   - an acceptance that names a different crate or kind than the finding it
 *     claims fails — an id reused for something else is not the reviewed thing.
 *
 * A finding is keyed by its advisory id. A yanked crate has no advisory, so it
 * is keyed `yanked:<crate>@<version>`; the version is part of the key because
 * a different yanked release is a different event that needs its own look.
 *
 * Fails closed on a scan it cannot read (exit 64): no output, output that is
 * not an audit report, or a finding with no crate name. An unavailable scanner
 * must never read as "nothing found".
 *
 * An acceptance is a claim that no fixed version can be reached from here and
 * why the affected code does not matter in the shipped app — never that
 * updating is inconvenient. Try `cargo update -p <crate>` first.
 *
 * CI-tier, deliberately absent from `pnpm check:all`: it needs the network
 * (the advisory database) and `cargo-audit` installed.
 *
 * Usage:
 *   node scripts/check-cargo-audit.mjs            # gate
 *   node scripts/check-cargo-audit.mjs --report   # list findings, never fails
 *
 * @coordinates-with scripts/cargo-audit-baseline.json — the reviewed acceptances
 * @coordinates-with .github/workflows/ci.yml — the rust-audit job
 * @coordinates-with .github/workflows/rust-scheduled.yml — the weekly run
 * @coordinates-with scripts/check-cargo-audit.test.mjs — runs this against a stub scanner
 * @module scripts/check-cargo-audit
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/isMainModule.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPTED = path.join(REPO, "scripts/cargo-audit-baseline.json");
const LOCKFILE = "src-tauri/Cargo.lock";

/** Thrown when scanner output cannot be read as an audit report. */
export class UnreadableScanError extends Error {}

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One finding out of either list, or a throw when it cannot be identified. */
function toFinding(kind, entry) {
  if (!isRecord(entry) || !isRecord(entry.package)) {
    throw new UnreadableScanError(`a ${kind} entry has no package`);
  }
  const { name, version } = entry.package;
  if (typeof name !== "string" || !name || typeof version !== "string" || !version) {
    throw new UnreadableScanError(`a ${kind} entry has no crate name or version`);
  }
  const advisory = isRecord(entry.advisory) ? entry.advisory : null;
  const advisoryId = typeof advisory?.id === "string" && advisory.id ? advisory.id : null;
  if (kind === "vulnerability" && !advisoryId) {
    throw new UnreadableScanError(`a vulnerability in ${name} has no advisory id`);
  }
  const patched = isRecord(entry.versions) && Array.isArray(entry.versions.patched)
    ? entry.versions.patched.join(", ")
    : "";
  return {
    id: advisoryId ?? `${kind}:${name}@${version}`,
    kind,
    crate: name,
    version,
    title: typeof advisory?.title === "string" ? advisory.title : "",
    patched,
  };
}

/**
 * Normalize `cargo audit --json` into a flat list of findings.
 *
 * Exported so tests can drive the comparison without the scanner.
 *
 * THROWS `UnreadableScanError` unless the output is an audit report: a JSON
 * object with a `vulnerabilities.list` array and a `warnings` map of arrays.
 * Anything else would otherwise normalize to an empty list, which is exactly
 * what a clean scan looks like.
 */
export function parseFindings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnreadableScanError("the output is not JSON");
  }
  if (!isRecord(parsed) || !isRecord(parsed.vulnerabilities) || !Array.isArray(parsed.vulnerabilities.list)) {
    throw new UnreadableScanError("no `vulnerabilities.list` in the output");
  }
  if (!isRecord(parsed.warnings)) {
    throw new UnreadableScanError("no `warnings` map in the output");
  }
  const findings = parsed.vulnerabilities.list.map((entry) => toFinding("vulnerability", entry));
  for (const [kind, list] of Object.entries(parsed.warnings)) {
    if (!Array.isArray(list)) throw new UnreadableScanError(`warnings.${kind} is not a list`);
    for (const entry of list) findings.push(toFinding(kind, entry));
  }
  // One advisory can be reported once per affected version of the same crate;
  // the acceptance is per advisory, so collapse to the first.
  const byId = new Map();
  for (const finding of findings) if (!byId.has(finding.id)) byId.set(finding.id, finding);
  return [...byId.values()];
}

/**
 * Compare findings against the acceptance file.
 *
 * Returns `{ unlisted, stale, unjustified, mismatched }` — every problem at
 * once rather than the first, so one run tells the whole story.
 */
export function evaluate(findings, acceptanceFile) {
  if (!isRecord(acceptanceFile) || !isRecord(acceptanceFile.accepted)) {
    throw new Error("scripts/cargo-audit-baseline.json has no `accepted` map");
  }
  const accepted = new Map(Object.entries(acceptanceFile.accepted));
  const byId = new Map(findings.map((f) => [f.id, f]));

  const unlisted = findings.filter((f) => !accepted.has(f.id));
  const stale = [...accepted.keys()].filter((id) => !byId.has(id));
  const unjustified = [...accepted.entries()]
    .filter(([, entry]) => !String(entry?.reason ?? "").trim())
    .map(([id]) => id);
  const mismatched = [...accepted.entries()]
    .filter(([id]) => byId.has(id))
    .flatMap(([id, entry]) => {
      const finding = byId.get(id);
      const problems = [];
      if (entry?.crate !== finding.crate) {
        problems.push(`${id}: accepted for crate ${JSON.stringify(entry?.crate)}, reported against ${finding.crate}`);
      }
      if (entry?.kind !== finding.kind) {
        problems.push(`${id}: accepted as ${JSON.stringify(entry?.kind)}, reported as ${finding.kind}`);
      }
      return problems;
    });

  return { unlisted, stale, unjustified, mismatched };
}

function describe(finding) {
  const title = finding.title ? ` — ${finding.title}` : "";
  return `${finding.kind} ${finding.crate} ${finding.version} ${finding.id}${title}`;
}

function scan() {
  try {
    return execFileSync("cargo", ["audit", "--json", "--file", LOCKFILE], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // `cargo audit` exits non-zero WHEN IT FINDS a vulnerability, with the
    // report on stdout. No stdout means the scan itself failed.
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    if (!stdout.trim()) {
      console.error("cargo-audit: the scan produced no output");
      console.error(String(error.stderr ?? error.message));
      process.exit(64);
    }
    return stdout;
  }
}

function main() {
  const report = process.argv.includes("--report");
  const raw = scan();
  if (!raw.trim()) {
    console.error("cargo-audit: the scan produced no output");
    process.exit(64);
  }

  let findings;
  try {
    findings = parseFindings(raw);
  } catch (error) {
    if (!(error instanceof UnreadableScanError)) throw error;
    // Before `--report` is consulted: listing "no findings" for a scan nobody
    // could read is the same false claim, only quieter.
    console.error(`cargo-audit: cannot read the scan output — ${error.message}`);
    console.error(raw.slice(0, 400));
    process.exit(64);
  }

  const acceptanceFile = JSON.parse(readFileSync(ACCEPTED, "utf8"));
  const { unlisted, stale, unjustified, mismatched } = evaluate(findings, acceptanceFile);

  const counts = findings.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(", ") || "none";
  console.log(`cargo-audit: ${findings.length} findings (${summary})`);

  if (report) {
    for (const f of findings) {
      console.log(`  [${acceptanceFile.accepted[f.id] ? "accepted" : "NEW"}] ${describe(f)}`);
    }
    return;
  }

  let failed = false;

  if (unlisted.length) {
    failed = true;
    console.error(`\n${unlisted.length} finding(s) are not reviewed:`);
    for (const f of unlisted) {
      console.error(`  ${describe(f)}`);
      if (f.patched) console.error(`    patched: ${f.patched}`);
    }
    console.error("\nUpdate the crate (`cargo update -p <crate>`), or add the id to");
    console.error("scripts/cargo-audit-baseline.json with the dependency path and the");
    console.error("reason no fixed version is reachable.");
  }

  if (stale.length) {
    failed = true;
    console.error(`\n${stale.length} acceptance(s) no longer apply:`);
    for (const id of stale) console.error(`  ${id}`);
    console.error("\nDelete them — an acceptance must not outlive its finding.");
  }

  if (unjustified.length) {
    failed = true;
    console.error(`\n${unjustified.length} acceptance(s) have no reason:`);
    for (const id of unjustified) console.error(`  ${id}`);
  }

  if (mismatched.length) {
    failed = true;
    console.error(`\n${mismatched.length} acceptance(s) do not describe the finding they name:`);
    for (const line of mismatched) console.error(`  ${line}`);
  }

  if (failed) process.exit(1);
  console.log("cargo-audit: every finding is reviewed and still current");
}

if (isMainModule(import.meta.url)) main();
