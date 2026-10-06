#!/usr/bin/env node
/**
 * Generate `THIRD_PARTY_LICENSES.txt` — the notices the shipped app must carry.
 *
 * MIT, BSD, ISC and Apache-2.0 each require their notice to accompany a binary
 * distribution, and the app bundles hundreds of components under them (plus
 * MPL-2.0 and EPL-2.0 code that reaches the webview through Mermaid). This
 * writes the license TEXTS, not a list of names, for:
 *   - the npm production closure of the app and the MCP sidecar, from
 *     `pnpm licenses list --prod` and each package's own license files;
 *   - the Rust crates of the four release targets, from `cargo about`
 *     (`src-tauri/about.toml` holds the accepted licenses and the targets);
 *   - components compiled into bundled packages, from
 *     `scripts/third-party-licenses/vendored.json`.
 * Any component with no text fails the run (exit 1), naming it.
 *
 * The output is tracked so that every checkout builds — `tauri-build` refuses
 * to compile when a `bundle.resources` entry names a missing file — and the
 * release workflow regenerates it before `tauri build`, so a shipped copy is
 * always exact for the tagged lockfiles even when the tracked copy is behind.
 *
 * Usage: node scripts/gen-third-party-licenses.mjs [--out=<path>]
 *   exit 0 written, 1 a component has no license text or a tool failed,
 *   64 bad invocation. Needs `pnpm` and `cargo about` (cargo-about 0.8) on PATH.
 *
 * @coordinates-with scripts/lib/thirdPartyLicenses.mjs — collection and validation
 * @coordinates-with scripts/lib/thirdPartyLicensesRender.mjs — the text output
 * @coordinates-with src-tauri/about.toml — cargo-about's accepted licenses and targets
 * @coordinates-with src-tauri/src/third_party_notices.rs — the app side that opens the file
 * @coordinates-with .github/workflows/release.yml — regenerates it before every release build
 * @coordinates-with scripts/gen-third-party-licenses.test.mjs — the self-test
 * @module scripts/gen-third-party-licenses
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/isMainModule.mjs";
import { collectEmbedded, collectNpm, collectRust, VENDORED_MANIFEST } from "./lib/thirdPartyLicenses.mjs";
import { renderNotices } from "./lib/thirdPartyLicensesRender.mjs";

const USAGE = "Usage: node scripts/gen-third-party-licenses.mjs [--out=<path>]";
export const OUTPUT_REL = "src-tauri/resources/generated/THIRD_PARTY_LICENSES.txt";
const VENDORED_TEXTS = "scripts/third-party-licenses/texts";
/** The workspace members whose production closure ships: the app and the sidecar. */
const SHIPPED_MANIFESTS = ["package.json", "server/mcp/package.json"];
const onWindows = process.platform === "win32";

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    shell: onWindows,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** The parsed vendored manifest. */
export function loadVendored(repo) {
  return JSON.parse(readFileSync(path.join(repo, VENDORED_MANIFEST), "utf8"));
}

/**
 * Every package in the shipped production closure, one per name and version.
 * The filters are read from the manifests, not typed here: `pnpm --filter`
 * with a name that matches nothing selects nothing and still exits 0.
 */
export function listNpmPackages(repo) {
  const filters = SHIPPED_MANIFESTS.flatMap((rel) => {
    const name = JSON.parse(readFileSync(path.join(repo, rel), "utf8")).name;
    if (typeof name !== "string" || name === "") throw new Error(`${rel} has no package name`);
    return ["--filter", name];
  });
  const report = JSON.parse(run("pnpm", [...filters, "licenses", "list", "--prod", "--json"], repo));
  const seen = new Map();
  for (const [license, pkgs] of Object.entries(report)) {
    for (const pkg of pkgs) {
      if (pkg.versions.length !== pkg.paths.length) {
        throw new Error(`pnpm reported ${pkg.versions.length} versions but ${pkg.paths.length} paths for ${pkg.name}`);
      }
      pkg.versions.forEach((version, i) => {
        seen.set(`${pkg.name}@${version}`, { name: pkg.name, version, license, dir: pkg.paths[i] });
      });
    }
  }
  return [...seen.values()];
}

/** The injected IO `collectNpm` needs, bound to the real tree. */
export function npmCollectInputs(repo, packages, vendored) {
  return {
    packages,
    vendored,
    listFiles: (dir) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name),
    readText: (file) => readFileSync(file, "utf8"),
    readVendored: (file) => readFileSync(path.join(repo, VENDORED_TEXTS, file), "utf8"),
  };
}

/** cargo-about's JSON report for the app crate. */
function cargoAbout(repo) {
  const json = run(
    "cargo",
    [
      "about",
      "generate",
      "--format",
      "json",
      "--locked",
      "--fail",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "-c",
      "src-tauri/about.toml",
    ],
    repo,
  );
  return JSON.parse(json);
}

/** The app crate's own name, from the `[package]` table of its manifest. */
export function appCrateName(repo) {
  const manifest = readFileSync(path.join(repo, "src-tauri/Cargo.toml"), "utf8");
  const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  if (!name) throw new Error("src-tauri/Cargo.toml has no [package] name");
  return name;
}

/** Build the notices text for the tree at `repo`; throws with every finding. */
export function generate(repo) {
  const vendored = loadVendored(repo);
  const inputs = npmCollectInputs(repo, listNpmPackages(repo), vendored);
  const npm = collectNpm(inputs);
  const rust = collectRust(cargoAbout(repo), { exclude: [appCrateName(repo)] });
  const embedded = collectEmbedded({
    embedded: vendored.embedded,
    lockfile: readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8"),
    readVendored: inputs.readVendored,
  });
  const errors = [...npm.errors, ...rust.errors, ...embedded.errors];
  if (errors.length > 0) {
    throw new Error(`third-party notices are incomplete:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  return renderNotices({ rust: rust.groups, npm: npm.entries, embedded: embedded.entries });
}

function parseArgs(argv, repo) {
  let out = path.join(repo, OUTPUT_REL);
  for (const a of argv) {
    if (a.startsWith("--out=") && a.length > "--out=".length) out = path.resolve(a.slice("--out=".length));
    else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  return { out };
}

function main() {
  const repo = path.resolve(import.meta.dirname, "..");
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), repo);
  } catch (error) {
    console.error(error.message);
    process.exit(64);
  }
  try {
    const text = generate(repo);
    mkdirSync(path.dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, text);
    console.log(`gen-third-party-licenses: wrote ${path.relative(repo, opts.out)} (${text.length} chars)`);
  } catch (error) {
    console.error(`gen-third-party-licenses: ${error.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
