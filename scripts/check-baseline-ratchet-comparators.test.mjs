// WI-RA13B.7 — the baseline ratchet's custom comparators (the TypeScript
// i18n allowlist, the contrastFloors pair comparator) and the shipped
// manifest against the real tree. Moved verbatim out of
// check-baseline-ratchet.test.mjs when scripts/ entered the file-size gate;
// the comparison modes stay there. Same method: the REAL script runs as a
// subprocess against scratch repositories, and every failure case asserts on
// the message, not just the exit code.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO, SCRIPT, scratchRepo, mutate, run, manifestOf } from "./__tests__/baselineRatchetFixtures.mjs";

// ─── custom: the TypeScript allowlist ───

describe("custom comparator: i18n identical allowlist (TypeScript source)", () => {
  const entry = {
    path: "scripts/i18nIdenticalAllowlist.ts",
    format: "text",
    checks: [{ mode: "custom", comparator: "tsIdenticalAllowlist", onAdd: "report" }],
  };

  const source = (entries) => `
export interface IdenticalException {
  kind: "json" | "yaml";
  ns: string;
  key: string;
  locales: string[];
  reason: string;
}
export const IDENTICAL_ALLOWLIST: IdenticalException[] = [
${entries
  .map(
    ([ns, key]) => `  {
    kind: "json",
    ns: "${ns}",
    key: "${key}",
    locales: ALL_LOCALES,
    reason: "untranslatable literal",
  },`,
  )
  .join("\n")}
];
`;

  it("reports an added exemption by namespace and key, ignoring the interface declaration", () => {
    const dir = scratchRepo({
      "scripts/i18nIdenticalAllowlist.ts": source([["settings.json", "formats.externalEditor.placeholder"]]),
    });
    mutate(dir, {
      "scripts/i18nIdenticalAllowlist.ts": source([
        ["settings.json", "formats.externalEditor.placeholder"],
        ["common.json", "ci.runnerLabels"],
      ]),
    });
    const { status, stdout } = run(dir, manifestOf([entry]));
    expect(status).toBe(0);
    expect(stdout).toContain("common.json");
    expect(stdout).toContain("ci.runnerLabels");
    // The `key: string;` interface field must not be read as an exemption.
    expect(stdout).not.toContain("kind: string");
  });

  it("passes when an exemption is deleted", () => {
    const dir = scratchRepo({
      "scripts/i18nIdenticalAllowlist.ts": source([
        ["settings.json", "a.b"],
        ["common.json", "c.d"],
      ]),
    });
    mutate(dir, { "scripts/i18nIdenticalAllowlist.ts": source([["settings.json", "a.b"]]) });
    expect(run(dir, manifestOf([entry])).status).toBe(0);
  });

  it("fails an added exemption when the manifest marks the list append-forbidden", () => {
    const strict = { ...entry, checks: [{ ...entry.checks[0], onAdd: "fail" }] };
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": source([["settings.json", "a.b"]]) });
    mutate(dir, {
      "scripts/i18nIdenticalAllowlist.ts": source([
        ["settings.json", "a.b"],
        ["common.json", "c.d"],
      ]),
    });
    const { status, stderr } = run(dir, manifestOf([strict]));
    expect(status).toBe(1);
    expect(stderr).toContain("c.d");
  });

  // ── Evasions the `ns: "…" … key: "…"` regex admitted ──
  // It recorded only DOUBLE-quoted ns-then-key pairs, so an exemption written
  // any other way was simply not in the identity set — added invisibly. And
  // because it matched lazily ACROSS entries, one malformed entry could pair
  // its `ns` with the NEXT entry's `key`.
  const strictEntry = {
    path: "scripts/i18nIdenticalAllowlist.ts",
    format: "text",
    checks: [{ mode: "custom", comparator: "tsIdenticalAllowlist", onAdd: "fail" }],
  };

  /** A source with fully hand-written entries, so quote style and field order
   *  can be varied per entry. */
  const rawSource = (entries) =>
    `const ALL_LOCALES = ["de", "es"];\nexport const IDENTICAL_ALLOWLIST: IdenticalException[] = [\n${entries.join(
      "\n",
    )}\n];\n`;

  const dq = (ns, key) =>
    `  { kind: "json", ns: "${ns}", key: "${key}", locales: ALL_LOCALES, reason: "x" },`;

  it("sees an exemption added with SINGLE quotes", () => {
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([dq("a.json", "a.b")]) });
    mutate(dir, {
      "scripts/i18nIdenticalAllowlist.ts": rawSource([
        dq("a.json", "a.b"),
        `  { kind: 'json', ns: 'sneaky.json', key: 'sneaky.key', locales: ALL_LOCALES, reason: 'x' },`,
      ]),
    });
    const { status, stderr } = run(dir, manifestOf([strictEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("sneaky.key");
  });

  it("sees an exemption whose properties are written in a different order", () => {
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([dq("a.json", "a.b")]) });
    mutate(dir, {
      "scripts/i18nIdenticalAllowlist.ts": rawSource([
        dq("a.json", "a.b"),
        `  { key: "reordered.key", locales: ALL_LOCALES, reason: "x", ns: "reordered.json", kind: "json" },`,
      ]),
    });
    const { status, stderr } = run(dir, manifestOf([strictEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("reordered.key");
  });

  it("sees an exemption widened to more locales", () => {
    // Same ns and key, more languages exempted — a real broadening of the
    // claim, and identical under an (ns, key) identity.
    const narrow = `  { kind: "json", ns: "a.json", key: "a.b", locales: ["de"], reason: "x" },`;
    const wide = `  { kind: "json", ns: "a.json", key: "a.b", locales: ["de", "fr", "ja"], reason: "x" },`;
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([narrow]) });
    mutate(dir, { "scripts/i18nIdenticalAllowlist.ts": rawSource([wide]) });
    const { status, stderr } = run(dir, manifestOf([strictEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("fr");
  });

  it("sees an exemption switched from a json namespace to the yaml bundle", () => {
    const asJson = `  { kind: "json", ns: "a.json", key: "a.b", locales: ["de"], reason: "x" },`;
    const asYaml = `  { kind: "yaml", ns: "a.json", key: "a.b", locales: ["de"], reason: "x" },`;
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([asJson]) });
    mutate(dir, { "scripts/i18nIdenticalAllowlist.ts": rawSource([asYaml]) });
    expect(run(dir, manifestOf([strictEntry])).status).toBe(1);
  });

  it("ignores locale REORDERING and reason edits — neither changes the claim", () => {
    const before = `  { kind: "json", ns: "a.json", key: "a.b", locales: ["fr", "de"], reason: "old wording" },`;
    const after = `  { kind: "json", ns: "a.json", key: "a.b", locales: ["de", "fr"], reason: "new, longer wording" },`;
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([before]) });
    mutate(dir, { "scripts/i18nIdenticalAllowlist.ts": rawSource([after]) });
    expect(run(dir, manifestOf([strictEntry])).status).toBe(0);
  });

  it("does not mistake prose inside a reason for an exemption", () => {
    // Real reasons contain quotes, braces and colons — one of the shipped ones
    // literally contains `"{{index}} / {{count}}"`.
    const tricky =
      `  { kind: "json", ns: "a.json", key: "a.b", locales: ["de"],\n` +
      `    reason: 'Pure interpolation ("{{index}} / {{count}}") — looks like ns: "ghost.json", key: "ghost.key".' },`;
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([tricky]) });
    mutate(dir, { "scripts/i18nIdenticalAllowlist.ts": rawSource([tricky, dq("b.json", "b.c")]) });
    const { status, stderr } = run(dir, manifestOf([strictEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("b.c");
    expect(stderr).not.toContain("ghost.key");
  });

  it("fails closed when the allowlist array cannot be parsed", () => {
    const dir = scratchRepo({ "scripts/i18nIdenticalAllowlist.ts": rawSource([dq("a.json", "a.b")]) });
    mutate(dir, {
      "scripts/i18nIdenticalAllowlist.ts": `export const IDENTICAL_ALLOWLIST = [\n  { ns: "a.json",\n`,
    });
    const { status } = run(dir, manifestOf([strictEntry]));
    expect(status).toBe(1);
  });
});

// ─── pair comparator: contrastFloors (WI-UI0.1) ───

describe("pair comparator: contrastFloors (theme-contrast baseline)", () => {
  const PATH = "scripts/theme-contrast-baseline.json";
  const floorEntry = {
    path: PATH,
    checks: [{ mode: "custom", comparator: "contrastFloors", onAdd: "report" }],
  };
  const doc = (floors, exempt = {}) => ({ failing: { paper: [] }, ansiFloor: floors, exempt });
  const REASON = "canonical palette, lifted per cell";

  it("fails a lowered floor (2.4 → 1.1), naming both values", () => {
    const dir = scratchRepo({ [PATH]: doc({ solarized: { value: 2.4, reason: REASON } }) });
    mutate(dir, { [PATH]: doc({ solarized: { value: 1.1, reason: REASON } }) });
    const { status, stderr } = run(dir, manifestOf([floorEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("2.4");
    expect(stderr).toContain("1.1");
    expect(stderr).toContain("only rise");
  });

  it("passes a raised floor (tightening)", () => {
    const dir = scratchRepo({ [PATH]: doc({ solarized: { value: 2.4, reason: REASON } }) });
    mutate(dir, { [PATH]: doc({ solarized: { value: 3.0, reason: REASON } }) });
    expect(run(dir, manifestOf([floorEntry])).status).toBe(0);
  });

  it("fails a floor whose reason is blank", () => {
    const dir = scratchRepo({ [PATH]: doc({ solarized: { value: 2.4, reason: REASON } }) });
    mutate(dir, { [PATH]: doc({ solarized: { value: 2.4, reason: " " } }) });
    const { status, stderr } = run(dir, manifestOf([floorEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("reason");
  });

  it("reports (but allows) a new floor and a new exempt entry under onAdd: report", () => {
    const dir = scratchRepo({ [PATH]: doc({}) });
    mutate(dir, {
      [PATH]: doc(
        { night: { value: 1.1, reason: REASON } },
        { solarized: [{ id: "ansi.black/bg.primary", reason: REASON }] },
      ),
    });
    const { status, stdout } = run(dir, manifestOf([floorEntry]));
    expect(status).toBe(0);
    expect(stdout).toContain("ansiFloor.night");
    expect(stdout).toContain("exempt solarized/ansi.black/bg.primary");
  });

  it("fails a new exempt entry with no reason", () => {
    const dir = scratchRepo({ [PATH]: doc({}) });
    mutate(dir, { [PATH]: doc({}, { solarized: [{ id: "x", reason: "" }] }) });
    expect(run(dir, manifestOf([floorEntry])).status).toBe(1);
  });

  it("the shipped per-theme identity entries catch a pair added under an existing theme", () => {
    // Codex objection #13: `object-keys` at `failing` alone cannot see this.
    // This fixture uses the shipped manifest's exact shape for one theme.
    const identityEntry = {
      path: PATH,
      checks: [
        { mode: "identity", at: "failing", shape: "object-keys", onAdd: "report" },
        { mode: "identity", at: "failing.paper", shape: "strings", onAdd: "fail" },
      ],
    };
    const dir = scratchRepo({ [PATH]: { failing: { paper: ["a/b"] }, ansiFloor: {}, exempt: {} } });
    mutate(dir, { [PATH]: { failing: { paper: ["a/b", "new/pair"] }, ansiFloor: {}, exempt: {} } });
    const { status, stderr } = run(dir, manifestOf([identityEntry]));
    expect(status).toBe(1);
    expect(stderr).toContain("new/pair");
  });

  // Audit 20260907 #13: the per-theme checks were a hand-kept list of six
  // names, so a seventh theme's list was unratcheted until someone edited
  // the manifest. `failing.*` derives them from the file's own keys.
  describe("`failing.*` derives one identity check per theme key", () => {
    const wildcard = {
      path: PATH,
      checks: [
        { mode: "identity", at: "failing", shape: "object-keys", onAdd: "report" },
        { mode: "identity", at: "failing.*", shape: "strings", onAdd: "fail" },
      ],
    };
    const doc2 = (paper, mint) => ({ failing: { paper, mint }, ansiFloor: {}, exempt: {} });

    it("catches a pair added under a theme the manifest never named", () => {
      const dir = scratchRepo({ [PATH]: doc2(["a/b"], ["c/d"]) });
      mutate(dir, { [PATH]: doc2(["a/b"], ["c/d", "mint/new"]) });
      const { status, stderr } = run(dir, manifestOf([wildcard]));
      expect(status).toBe(1);
      expect(stderr).toContain("failing.mint");
      expect(stderr).toContain("mint/new");
    });

    it("passes an unchanged file and a removed pair, and reports a theme that ARRIVES", () => {
      const dir = scratchRepo({ [PATH]: doc2(["a/b"], ["c/d"]) });
      expect(run(dir, manifestOf([wildcard])).status).toBe(0);
      mutate(dir, { [PATH]: doc2(["a/b"], []) });
      expect(run(dir, manifestOf([wildcard])).status).toBe(0);
      mutate(dir, { [PATH]: { failing: { paper: ["a/b"], mint: ["c/d"], seventh: [] }, ansiFloor: {}, exempt: {} } });
      const arrived = run(dir, manifestOf([wildcard]));
      expect(arrived.status, arrived.stderr).toBe(0);
      expect(arrived.stdout).toContain("seventh");
    });

    it("fails closed when the wildcard's parent is not an object or expands to nothing", () => {
      const dir = scratchRepo({ [PATH]: doc2(["a/b"], ["c/d"]) });
      mutate(dir, { [PATH]: { failing: [], ansiFloor: {}, exempt: {} } });
      const notObject = run(dir, manifestOf([wildcard]));
      expect(notObject.status).toBe(1);
      expect(notObject.stderr).toContain('expands "failing.*"');
      mutate(dir, { [PATH]: { failing: { "//": "prose only" }, ansiFloor: {}, exempt: {} } });
      const empty = run(dir, manifestOf([wildcard]));
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("expands to no keys");
    });
  });
});

// ─── the shipped manifest describes the real tree ───

describe("shipped manifest", () => {
  it("covers every baseline the discovery globs find in this repository", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--list"], { cwd: REPO, encoding: "utf8" });
    expect(res.status).toBe(0);
    // --list prints "registered <path>" / "UNREGISTERED <path>" lines.
    expect(res.stdout).not.toContain("UNREGISTERED");
    expect(res.stdout).not.toContain("MISSING");
  });

  it("ratchets EVERY theme's failing list in theme-contrast-baseline.json, derived from the file's keys", async () => {
    // The root `object-keys` check only sees a theme ARRIVE. A theme whose
    // `failing.<theme>` list has no per-theme `strings`/`onAdd: "fail"` check
    // could then grow that list silently on every later change — the
    // count-like substitution §11 forbids. The manifest used to name six
    // themes by hand; it now carries `failing.*`, and this runs the engine on
    // the live file to prove the expansion reaches each theme key.
    const { MANIFEST } = await import("./baselineRatchetManifest.mjs");
    const { evaluateCheck } = await import("./baselineRatchetModes.mjs");
    const entry = MANIFEST.entries.find((e) => e.path === "scripts/theme-contrast-baseline.json");
    const wildcard = entry.checks.find((c) => c.mode === "identity" && c.at === "failing.*");
    expect(wildcard).toMatchObject({ shape: "strings", onAdd: "fail" });
    expect(entry.checks.some((c) => c.mode === "identity" && /^failing\.[a-z]+$/.test(c.at))).toBe(false);
    const doc = JSON.parse(readFileSync(path.join(REPO, "scripts/theme-contrast-baseline.json"), "utf8"));
    const themes = Object.keys(doc.failing).filter((k) => !k.startsWith("//") && !k.startsWith("_")).sort();
    expect(themes.length).toBeGreaterThan(0);
    // Add one pair under EVERY theme: each must be refused by name.
    const grown = { ...doc, failing: Object.fromEntries(themes.map((t) => [t, [...doc.failing[t], `${t}/probe-pair`]])) };
    const { failures } = evaluateCheck(wildcard, doc, grown, entry.path);
    for (const t of themes) expect(failures.join("\n"), t).toContain(`${t}/probe-pair`);
  });

  it("checks every section of the file-size baseline, not just one", async () => {
    // Registering a file while checking only part of it is the quiet version
    // of not registering it: `--list` would still read as covered.
    const { MANIFEST } = await import("./baselineRatchetManifest.mjs");
    const entry = MANIFEST.entries.find((e) => e.path === "scripts/file-size-baseline.json");
    expect(entry.checks).toEqual([
      { mode: "scalar", at: "limit" },
      { mode: "scalar", at: "testLimit" },
      { mode: "per-key-count", at: "files", onAdd: "fail" },
      { mode: "per-key-count", at: "testFiles", onAdd: "fail" },
    ]);
  });

  // Audit 20260815-163607 #6. The test above pins ONE file's checks by hand, so
  // adding a third budget to a two-budget baseline left it unregistered and
  // every coverage test still green — the ratchet would then never compare it
  // against the merge base, which is the one thing it exists to do. This asserts
  // the property for every registered file instead of enumerating one.
  it("registers a check for every numeric budget in every baseline file", async () => {
    const { MANIFEST } = await import("./baselineRatchetManifest.mjs");
    const { readFileSync, existsSync } = await import("node:fs");

    for (const entry of MANIFEST.entries) {
      if (!existsSync(entry.path)) continue; // absence is the manifest's own staleness check
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(entry.path, "utf8"));
      } catch {
        continue; // not JSON (e.g. a .json5/.txt baseline) — nothing to enumerate
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

      const checked = new Set(entry.checks.map((c) => c.at));
      // `at: ""` addresses the ROOT object, so one such check covers every key
      // in the file — knip-baseline.json is registered exactly that way.
      if (checked.has("")) continue;

      for (const [key, value] of Object.entries(parsed)) {
        // `//`-prefixed keys are the house convention for prose in a JSON baseline.
        if (key.startsWith("//")) continue;
        if (typeof value !== "number") continue;
        expect(checked, `${entry.path}: numeric budget \`${key}\` is not registered`).toContain(key);
      }
    }
  });

  it("gives every registered baseline at least one well-formed check", async () => {
    const { MANIFEST } = await import("./baselineRatchetManifest.mjs");
    const modes = new Set(["scalar", "per-key-count", "identity", "custom"]);
    for (const entry of MANIFEST.entries) {
      expect(entry.checks.length, entry.path).toBeGreaterThan(0);
      for (const check of entry.checks) {
        expect(modes, `${entry.path}: ${check.mode}`).toContain(check.mode);
        if (check.mode === "identity") {
          expect(["strings", "objects", "object-keys"]).toContain(check.shape);
          expect(["fail", "report"]).toContain(check.onAdd);
        }
        // A per-file count gate refuses a new dirty file itself, so its
        // baseline must refuse a new key here too (audit 20260907 #12).
        if (check.mode === "per-key-count") expect(check.onAdd, `${entry.path}: ${check.at}`).toBe("fail");
      }
    }
  });

  it("requires a reason on every allowRaise exemption", async () => {
    const { MANIFEST } = await import("./baselineRatchetManifest.mjs");
    for (const entry of MANIFEST.allowRaise) {
      expect(entry.reason?.trim(), `${entry.path}:${entry.key}`).toBeTruthy();
      expect(MANIFEST.entries.some((e) => e.path === entry.path)).toBe(true);
    }
  });
});
