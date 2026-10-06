// The PTY spawn policy and the environment the terminal actually sends must
// name the same keys.
//
// `src-tauri/src/pty/spawn_policy.rs` refuses a spawn whose env carries any key
// outside `ALLOWED_ENV_KEYS` ("Not an environment variable a terminal may
// set"). That refusal is deliberate — a frontend that starts sending something
// new must fail loudly — but it means a key added on the TypeScript side
// without a matching Rust edit refuses EVERY terminal spawn, and the Rust unit
// test that lists "every key the frontend sets" restates the list by hand, so
// it drifts with it. This test reads both sides from source instead:
//
//   - `buildBaseTerminalEnv` is CALLED, on a macOS navigator with a workspace,
//     so every branch that adds a key runs;
//   - `env.KEY =` assignments in terminalSpawnEnv.ts and spawnPty.ts are
//     scanned, which catches keys added after the base env is built (the
//     transcript token) and any branch the call above does not take;
//   - the keys zsh shell integration inserts are read from `build_zsh_env` in
//     shell_integration.rs — `buildShellSpawnConfig` merges them in verbatim.
//
// The two sets must be EQUAL: a missing key breaks every spawn, and a stale
// one widens the door the policy exists to narrow.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildBaseTerminalEnv } from "../src/components/Terminal/terminalSpawnEnv.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");

const SPAWN_POLICY = "src-tauri/src/pty/spawn_policy.rs";
const SHELL_INTEGRATION = "src-tauri/src/shell_integration.rs";
const FRONTEND_SOURCES = [
  "src/components/Terminal/terminalSpawnEnv.ts",
  "src/components/Terminal/spawnPty.ts",
];

/** `ALLOWED_ENV_KEYS` from the Rust source; its declared length must match. */
function parseAllowedEnvKeys(rust) {
  const m = rust.match(/const ALLOWED_ENV_KEYS: \[&str; (\d+)\] = \[([^\]]*)\];/);
  if (!m) throw new Error(`${SPAWN_POLICY}: no \`const ALLOWED_ENV_KEYS: [&str; N] = [...]\``);
  const keys = [...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]);
  if (keys.length !== Number(m[1])) {
    throw new Error(`ALLOWED_ENV_KEYS declares ${m[1]} entries but lists ${keys.length}`);
  }
  return keys;
}

/** Keys `build_zsh_env` inserts into the integration env. */
function parseZshIntegrationKeys(rust) {
  const start = rust.indexOf("fn build_zsh_env(");
  if (start < 0) throw new Error(`${SHELL_INTEGRATION}: no \`fn build_zsh_env\``);
  const end = rust.indexOf("\n}\n", start);
  const body = rust.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/insert\(\s*"([A-Z0-9_]+)"/g)].map((k) => k[1]);
}

/** Keys a TypeScript source assigns as `env.KEY =` (not `==`). */
function parseEnvAssignments(ts) {
  return [...ts.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\s*=(?!=)/g)].map((k) => k[1]);
}

function frontendKeys() {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const base = Object.keys(buildBaseTerminalEnv("/usr/bin", "/workspace"));
  const assigned = FRONTEND_SOURCES.flatMap((rel) => parseEnvAssignments(read(rel)));
  const integration = parseZshIntegrationKeys(read(SHELL_INTEGRATION));
  return { base, assigned, integration, all: new Set([...base, ...assigned, ...integration]) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PTY spawn env keys", () => {
  it("every source of keys is actually read (a scan that finds nothing is broken, not clean)", () => {
    const { base, assigned, integration } = frontendKeys();
    expect(base).toContain("TERM");
    expect(base).toContain("LC_CTYPE"); // the macOS branch ran
    expect(base).toContain("VMARK_WORKSPACE"); // the workspace branch ran
    expect(assigned).toContain("VMARK_TRANSCRIPT_TOKEN");
    expect(integration).toEqual(expect.arrayContaining(["ZDOTDIR", "USER_ZDOTDIR"]));
    expect(parseAllowedEnvKeys(read(SPAWN_POLICY)).length).toBeGreaterThan(0);
  });

  it("ALLOWED_ENV_KEYS is exactly the set of keys a terminal spawn can carry", () => {
    const allowed = [...parseAllowedEnvKeys(read(SPAWN_POLICY))].sort();
    const sent = [...frontendKeys().all].sort();
    expect(allowed).toEqual(sent);
  });
});

describe("the parsers", () => {
  it("rejects an ALLOWED_ENV_KEYS whose declared length disagrees with its entries", () => {
    expect(() => parseAllowedEnvKeys('const ALLOWED_ENV_KEYS: [&str; 2] = ["A"];')).toThrow(
      /declares 2 entries but lists 1/,
    );
  });

  it("fails loudly when the Rust shapes it reads are gone", () => {
    expect(() => parseAllowedEnvKeys("const OTHER: [&str; 0] = [];")).toThrow(/ALLOWED_ENV_KEYS/);
    expect(() => parseZshIntegrationKeys("fn other() {}")).toThrow(/build_zsh_env/);
  });

  it("reads assignments, not comparisons or lowercase properties", () => {
    expect(parseEnvAssignments('env.FOO = "1"; if (env.BAR === x) {} env.path = y;')).toEqual(["FOO"]);
  });
});
