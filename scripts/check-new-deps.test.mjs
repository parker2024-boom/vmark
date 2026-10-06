// WI-RA13A.1 — the slopsquatting gate flags a missing, young, unpopular or unverifiable new dependency
/**
 * Runs the REAL `scripts/check-new-deps.sh` in a scratch git repo in tmpdir,
 * with `npm` and `curl` stubs on PATH standing in for the registry. No network:
 * the stubs answer from a fixture file, and record every call so the test can
 * also assert WHAT the gate asked about.
 *
 * Semantics pinned:
 *   - no new dependency -> exit 0;
 *   - a new dependency that is old and popular -> exit 0;
 *   - not on the registry / younger than MIN_AGE_DAYS / fewer than
 *     MIN_WEEKLY_DL downloads -> exit 1, each named with its reason;
 *   - anything the registry cannot describe (lookup error, empty metadata, no
 *     creation date, no download count) -> exit 1, never a pass;
 *   - the package that is CHECKED is the package that is INSTALLED: an
 *     `npm:` alias is looked up by its target, and a spec that bypasses the
 *     registry (git, URL, tarball) is flagged because nothing can vouch for it;
 *   - re-pointing an EXISTING dependency name at a different package counts as
 *     a new dependency.
 *
 * @coordinates-with scripts/check-new-deps.sh — the gate under test
 * @module scripts/check-new-deps.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-new-deps.sh");
const DAY_MS = 86_400_000;

/** An ISO creation timestamp `days` (may be fractional) before now. */
const createdDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

/** A package the gate should wave through. */
const healthy = { created: "2015-03-01T10:00:00.000Z", downloads: 500_000 };

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/**
 * The registry stub, shared by the `npm` and `curl` shims.
 *
 * `registry.json` maps package name -> `{ created, downloads, view }`:
 *   - absent name            -> `npm view` fails with E404;
 *   - `view: "network"`      -> `npm view` fails with a non-404 error;
 *   - `view: "empty"`        -> `npm view` succeeds and prints nothing;
 *   - `created` omitted      -> metadata has no creation time;
 *   - `downloads` omitted    -> the downloads endpoint fails.
 */
const STUB = `
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname);
const registry = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf8"));
const [tool, ...args] = process.argv.slice(2);
appendFileSync(path.join(dir, "calls.log"), JSON.stringify([tool, ...args]) + "\\n");
if (tool === "npm") {
  if (args[0] !== "view" || args[2] !== "--json") { console.error("unexpected npm " + args.join(" ")); process.exit(97); }
  const pkg = registry[args[1]];
  if (!pkg) { console.error("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/" + args[1]); process.exit(1); }
  if (pkg.view === "network") { console.error("npm error code ECONNRESET\\nnpm error network aborted"); process.exit(1); }
  if (pkg.view === "empty") process.exit(0);
  console.log(JSON.stringify({ name: args[1], time: pkg.created ? { created: pkg.created } : {} }));
} else if (tool === "curl") {
  const prefix = "https://api.npmjs.org/downloads/point/last-week/";
  const url = args.find((a) => a.startsWith("https://"));
  if (!url || !url.startsWith(prefix)) { console.error("unexpected curl " + args.join(" ")); process.exit(97); }
  const pkg = registry[decodeURIComponent(url.slice(prefix.length))];
  if (!pkg || pkg.downloads === undefined) process.exit(22);
  console.log(JSON.stringify({ downloads: pkg.downloads }));
} else {
  process.exit(97);
}
`;

/**
 * A scratch repo: `base` manifests committed on `main`, `head` manifests
 * committed on a feature branch, and a stub registry. Manifests are keyed by
 * repo-relative path; a string value is written verbatim (for malformed JSON).
 */
function scratch({ base = { "package.json": {} }, head, registry = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), "new-deps-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(SCRIPT, path.join(root, "scripts", "check-new-deps.sh"));

  const writeManifests = (manifests) => {
    for (const [rel, body] of Object.entries(manifests)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    }
  };

  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeManifests(base);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  writeManifests(head);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head", "--allow-empty");

  // Outside the repo's tracked tree would be tidier, but the script only reads
  // the manifests it names, so an untracked bin/ beside them is inert.
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "stub.mjs"), STUB);
  writeFileSync(path.join(bin, "registry.json"), JSON.stringify(registry));
  for (const tool of ["npm", "curl"]) {
    const shim = path.join(bin, tool);
    writeFileSync(shim, `#!/bin/bash\nexec "${process.execPath}" "${path.join(bin, "stub.mjs")}" ${tool} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return { root, bin };
}

function run({ root, bin }, args = ["main"], env = {}) {
  const r = spawnSync("bash", [path.join(root, "scripts", "check-new-deps.sh"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  const log = path.join(bin, "calls.log");
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { ...r, out: r.stdout + r.stderr, calls };
}

/** One-manifest shorthand: the root package.json gains these dependencies. */
const adding = (dependencies, registry, field = "dependencies") =>
  scratch({ head: { "package.json": { [field]: dependencies } }, registry });

describe("check-new-deps.sh — nothing new, or new and healthy", () => {
  it("exits 0 and never touches the registry when no dependency was added", () => {
    const deps = { dependencies: { react: "^19.0.0" } };
    const r = run(scratch({ base: { "package.json": deps }, head: { "package.json": deps } }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("no new dependencies vs main");
    expect(r.calls).toEqual([]);
  });

  it("a version bump of an existing dependency is not a new dependency", () => {
    const r = run(
      scratch({
        base: { "package.json": { dependencies: { react: "^18.0.0" } } },
        head: { "package.json": { dependencies: { react: "^19.0.0" } } },
      }),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("exits 0 for a new dependency that is old and popular", () => {
    const r = run(adding({ "left-pad": "^1.3.0" }, { "left-pad": healthy }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/✓ left-pad — age=\d+d, dl\/wk=500000/);
    expect(r.out).toContain("All new dependencies pass");
  });

  it.each(["devDependencies", "optionalDependencies"])("scans %s too", (field) => {
    const r = run(adding({ ghost: "1.0.0" }, {}, field));
    expect(r.status).toBe(1);
    expect(r.out).toContain("ghost — NOT FOUND on npm");
  });

  it("a script entry that looks like a package name is not a dependency", () => {
    const r = run(scratch({ head: { "package.json": { scripts: { "e2e:smoke": "node x.mjs" } } } }));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("workspace:, link: and file: references are local, not registry packages", () => {
    const r = run(adding({ a: "workspace:*", b: "link:../b", c: "file:../c" }, {}));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("a scoped package is looked up by its full name, URL-encoded for the downloads API", () => {
    const r = run(adding({ "@scope/pkg": "^1.0.0" }, { "@scope/pkg": healthy }));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContainEqual(["npm", "view", "@scope/pkg", "--json"]);
    const curl = r.calls.find(([tool]) => tool === "curl");
    expect(curl.join(" ")).toContain("/last-week/@scope%2Fpkg");
  });
});

describe("check-new-deps.sh — each flag condition", () => {
  it("a package that does not exist on the registry is flagged as likely hallucinated", () => {
    const r = run(adding({ "react-super-hooks-pro": "^1.0.0" }, {}));
    expect(r.status).toBe(1);
    expect(r.out).toContain("react-super-hooks-pro — NOT FOUND on npm (likely hallucinated)");
    expect(r.out).toContain("1 new dependency(ies) flagged");
  });

  it("a package younger than the minimum age is flagged", () => {
    const r = run(adding({ fresh: "^0.0.1" }, { fresh: { created: createdDaysAgo(5), downloads: 900_000 } }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/⚠ fresh — flagged: created [45]d ago \(<30\)/);
  });

  it("a package with too few weekly downloads is flagged", () => {
    const r = run(adding({ lonely: "^2.0.0" }, { lonely: { created: healthy.created, downloads: 12 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("⚠ lonely — flagged: 12 dl/week (<1000)");
  });

  it("young AND unpopular reports both reasons", () => {
    const r = run(adding({ both: "1.0.0" }, { both: { created: createdDaysAgo(2), downloads: 3 } }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/both — flagged: created \dd ago \(<30\), 3 dl\/week \(<1000\)/);
  });

  it("the thresholds are exclusive: exactly 30 days and exactly 1000 downloads pass", () => {
    const r = run(adding({ edge: "1.0.0" }, { edge: { created: createdDaysAgo(30 + 1 / 24), downloads: 1000 } }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("✓ edge — age=30d, dl/wk=1000");
  });

  it("one day and one download under the thresholds are flagged", () => {
    const r = run(adding({ edge: "1.0.0" }, { edge: { created: createdDaysAgo(29 + 1 / 24), downloads: 999 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("created 29d ago (<30), 999 dl/week (<1000)");
  });

  it("MIN_AGE_DAYS and MIN_WEEKLY_DL move the thresholds", () => {
    const s = adding({ mid: "1.0.0" }, { mid: { created: createdDaysAgo(10.5), downloads: 50 } });
    expect(run(s).status).toBe(1);
    const relaxed = run(s, ["main"], { MIN_AGE_DAYS: "7", MIN_WEEKLY_DL: "50" });
    expect(relaxed.status, relaxed.out).toBe(0);
  });

  it("one bad package among good ones fails the run and counts only the bad one", () => {
    const r = run(adding({ good: "1.0.0", ghost: "1.0.0", fine: "1.0.0" }, { good: healthy, fine: healthy }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("✓ good");
    expect(r.out).toContain("✓ fine");
    expect(r.out).toContain("ghost — NOT FOUND");
    expect(r.out).toContain("1 new dependency(ies) flagged");
  });

  it.each(["server/mcp/package.json", "server/content/package.json", "website/package.json"])(
    "a hallucinated dependency in %s is caught",
    (manifest) => {
      const r = run(
        scratch({
          base: { "package.json": {}, [manifest]: {} },
          head: { [manifest]: { dependencies: { ghost: "1.0.0" } } },
        }),
      );
      expect(r.status).toBe(1);
      expect(r.out).toContain(`new dependencies in ${manifest}`);
    },
  );

  it("a manifest that did not exist at the base counts every dependency as new", () => {
    const r = run(
      scratch({ head: { "website/package.json": { dependencies: { ghost: "1.0.0" } } } }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("ghost — NOT FOUND");
  });
});

describe("check-new-deps.sh — what the registry cannot describe never passes", () => {
  it("a lookup that fails for a reason other than 404 is flagged", () => {
    const r = run(adding({ flaky: "1.0.0" }, { flaky: { ...healthy, view: "network" } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("flaky — npm metadata lookup failed (failing closed)");
  });

  it("empty metadata is flagged", () => {
    const r = run(adding({ blank: "1.0.0" }, { blank: { ...healthy, view: "empty" } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("blank — empty npm metadata (failing closed)");
  });

  it("metadata with no creation date is flagged", () => {
    const r = run(adding({ undated: "1.0.0" }, { undated: { downloads: 500_000 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("creation date unavailable (fail closed)");
  });

  it("an unparseable creation date is flagged", () => {
    const r = run(adding({ odd: "1.0.0" }, { odd: { created: "sometime last year", downloads: 500_000 } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("creation date unavailable (fail closed)");
  });

  it("an unreachable downloads endpoint is flagged", () => {
    const r = run(adding({ quiet: "1.0.0" }, { quiet: { created: healthy.created } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("download count unavailable (fail closed)");
  });

  it("a non-numeric download count is flagged, not read as zero-or-fine", () => {
    const r = run(adding({ weird: "1.0.0" }, { weird: { created: healthy.created, downloads: "lots" } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("download count unavailable (fail closed)");
  });

  it("a malformed manifest fails closed", () => {
    const r = run(scratch({ head: { "package.json": '{ "dependencies": { "a": ' } }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("failed to parse package.json — failing closed");
  });

  it("a malformed BASE manifest treats every dependency as new rather than none", () => {
    const r = run(
      scratch({
        base: { "package.json": "{ not json" },
        head: { "package.json": { dependencies: { ghost: "1.0.0" } } },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("ghost — NOT FOUND");
  });

  it("an unresolvable base ref exits 64 instead of comparing against nothing", () => {
    const r = run(adding({ "left-pad": "1.0.0" }, { "left-pad": healthy }), ["no-such-ref"]);
    expect(r.status).toBe(64);
    expect(r.out).toContain("base ref 'no-such-ref' does not resolve");
  });
});

describe("check-new-deps.sh — the package checked is the package installed", () => {
  it("an npm: alias is looked up by its TARGET, not by the innocent-looking key", () => {
    // `lodash` exists and is healthy; the thing actually installed does not.
    const r = run(adding({ lodash: "npm:lodahs-utils@^1.0.0" }, { lodash: healthy }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("lodahs-utils — NOT FOUND on npm");
    expect(r.calls).not.toContainEqual(["npm", "view", "lodash", "--json"]);
  });

  it("a scoped alias target is parsed whole", () => {
    const r = run(adding({ x: "npm:@evil/pkg@1.2.3" }, { x: healthy }));
    expect(r.status).toBe(1);
    expect(r.calls).toContainEqual(["npm", "view", "@evil/pkg", "--json"]);
  });

  it("an alias with no version still resolves its target", () => {
    const r = run(adding({ x: "npm:real-thing" }, { "real-thing": healthy }));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContainEqual(["npm", "view", "real-thing", "--json"]);
  });

  it("re-pointing an EXISTING name at another package is a new dependency", () => {
    const r = run(
      scratch({
        base: { "package.json": { dependencies: { lodash: "^4.17.21" } } },
        head: { "package.json": { dependencies: { lodash: "npm:lodahs-utils@^1.0.0" } } },
        registry: { lodash: healthy },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("lodahs-utils — NOT FOUND on npm");
  });

  it("an alias that already pointed at the same target is not new", () => {
    const manifest = { dependencies: { x: "npm:real-thing@^1.0.0" } };
    const bumped = { dependencies: { x: "npm:real-thing@^2.0.0" } };
    const r = run(scratch({ base: { "package.json": manifest }, head: { "package.json": bumped } }));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it.each([
    ["a GitHub shorthand", "someone/some-repo"],
    ["a github: spec", "github:someone/some-repo#main"],
    ["a git URL", "git+https://example.com/someone/repo.git"],
    ["an https tarball", "https://example.com/pkg-1.0.0.tgz"],
    ["an http tarball", "http://example.com/pkg-1.0.0.tgz"],
  ])("%s bypasses the registry and is flagged", (_label, spec) => {
    const r = run(adding({ "left-pad": spec }, { "left-pad": healthy }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("left-pad — not a registry version");
    expect(r.out).toContain("1 new dependency(ies) flagged");
  });

  it("re-pointing an existing dependency at a git URL is flagged", () => {
    const r = run(
      scratch({
        base: { "package.json": { dependencies: { "left-pad": "^1.3.0" } } },
        head: { "package.json": { dependencies: { "left-pad": "github:someone/left-pad" } } },
        registry: { "left-pad": healthy },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("left-pad — not a registry version");
  });

  it.each(["^1.2.3", "~1.2.3", "1.2.3", ">=1 <2", "1.x", "*", "latest", "1.2.3-beta.1", "", "^1 || ^2"])(
    "the registry spec %j is an ordinary dependency",
    (spec) => {
      const r = run(adding({ "left-pad": spec }, { "left-pad": healthy }));
      expect(r.status, r.out).toBe(0);
    },
  );
});

// WI-RA13B.7 — overrides can redirect a package without touching a dependency
// map, so they are read exactly like dependencies.
describe("check-new-deps.sh — overrides redirect what is installed", () => {
  const withOverrides = (overrides, registry, base = {}) =>
    scratch({ base: { "package.json": base }, head: { "package.json": { ...base, ...overrides } }, registry });

  it("a pnpm.overrides alias is looked up by its target", () => {
    const r = run(withOverrides({ pnpm: { overrides: { tar: "npm:tar-evil@1.0.0" } } }, { tar: healthy }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("tar-evil — NOT FOUND on npm");
  });

  it("an npm overrides entry pointing at a git URL is flagged", () => {
    const r = run(withOverrides({ overrides: { qs: "github:someone/qs" } }, { qs: healthy }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("qs — not a registry version");
  });

  it("a nested npm override is read, including its `.` self-entry", () => {
    const r = run(withOverrides({ overrides: { foo: { ".": "npm:foo-evil@1", bar: "npm:bar-evil@1" } } }, {}));
    expect(r.status).toBe(1);
    expect(r.out).toContain("foo-evil — NOT FOUND on npm");
    expect(r.out).toContain("bar-evil — NOT FOUND on npm");
  });

  it("a selector with a version range or a parent path names the package it overrides", () => {
    const r = run(
      withOverrides(
        { pnpm: { overrides: { "undici@<6.24.0": "https://example.com/u.tgz", "a>@scope/b@2": "github:x/b" } } },
        {},
      ),
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("undici — not a registry version");
    expect(r.out).toContain("@scope/b — not a registry version");
  });

  it("a version-range override of a healthy package passes", () => {
    const r = run(withOverrides({ pnpm: { overrides: { tar: ">=7.5.19 <8" } } }, { tar: healthy }));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContainEqual(["npm", "view", "tar", "--json"]);
  });

  it("an override already present at the base is not new; `$ref` and `-` install nothing new", () => {
    const base = { pnpm: { overrides: { tar: ">=7 <8" } }, dependencies: { tar: "^7.0.0" } };
    const r = run(withOverrides({ pnpm: { overrides: { tar: ">=7.5 <8", foo: "$tar", gone: "-" } } }, {}, base));
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("yarn resolutions are read too", () => {
    const r = run(withOverrides({ resolutions: { "**/lodash": "npm:lodahs@1" } }, {}));
    expect(r.status).toBe(1);
    expect(r.out).toContain("lodahs — NOT FOUND on npm");
  });
});
