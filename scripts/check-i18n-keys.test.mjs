// WI-RA13A.4 — the i18n gate goes red for a missing key, a broken placeholder, an empty or copied-English value, and a baseline it cannot find
/**
 * Runs the REAL `scripts/check-i18n-keys.ts` as a subprocess in a scratch tree.
 *
 * The scratch tree is a copy of this repository's own locale files plus the
 * few source files the fragment registry names, so an unmodified copy must
 * pass — and each test then makes ONE change and asserts the run goes red for
 * that reason. The pure classifiers have their own table tests in
 * `check-i18n-copy.test.ts`; what was never pinned is the thing CI actually
 * runs: the whole script, its file walking, and its exit code.
 *
 * Keys are picked from the live English bundle at run time rather than named
 * here, so renaming a UI string does not break this file.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate under test
 * @coordinates-with scripts/check-i18n-copy.test.ts — table tests of its pure classifiers
 * @module scripts/check-i18n-keys.test
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REGISTERED_FRAGMENTS } from "./check-i18n-keys.ts";
import { allowedEntries } from "./i18nIdenticalAllowlist.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const LANG = "zh-CN";
const YML = "zh-CN.yml";

/** A fresh scratch copy of everything the gate reads. */
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), "i18n-keys-"));
  const copy = (rel) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    cpSync(path.join(REPO, rel), path.join(root, rel), { recursive: true });
  };
  copy("src/locales");
  copy("src-tauri/locales");
  // The fragment check requires every registered site to exist and use its key.
  for (const { files } of Object.values(REGISTERED_FRAGMENTS)) files.forEach(copy);
  // The gate, whatever modules it is split across, and its data files.
  for (const name of readdirSync(path.join(REPO, "scripts"))) {
    if (/i18n/i.test(name) && !/\.test\./.test(name)) copy(`scripts/${name}`);
  }
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  for (const name of readdirSync(path.join(REPO, "scripts", "lib"))) {
    if (name.startsWith("isMainModule.") && !name.includes(".test.")) copy(`scripts/lib/${name}`);
  }
  // `typescript` and `tsx` resolve through the real install.
  symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  return root;
}

function run(root, args = []) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-i18n-keys.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { ...r, out: r.stdout + r.stderr };
}

const readJson = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
const writeJson = (root, rel, data) => writeFileSync(path.join(root, rel), JSON.stringify(data, null, 2) + "\n");
const editJson = (root, rel, edit) => {
  const data = readJson(root, rel);
  edit(data);
  writeJson(root, rel, data);
};
const editText = (root, rel, edit) =>
  writeFileSync(path.join(root, rel), edit(readFileSync(path.join(root, rel), "utf8")));

const EN = JSON.parse(readFileSync(path.join(REPO, "src/locales/en/common.json"), "utf8"));
const ZH = JSON.parse(readFileSync(path.join(REPO, `src/locales/${LANG}/common.json`), "utf8"));
const NS = `src/locales/${LANG}/common.json`;

/** First English key in common.json whose value satisfies `pick`. */
function keyWhere(pick, label) {
  const found = Object.entries(EN).find(([key, value]) => typeof value === "string" && pick(key, value));
  if (!found) throw new Error(`no common.json key for this case: ${label}`);
  return found[0];
}
const ANY_KEY = keyWhere((key) => typeof ZH[key] === "string", "any translated key");
const PLACEHOLDER_KEY = keyWhere((_k, v) => /\{\{\w+\}\}/.test(v), "a value with a placeholder");
const PLACEHOLDER = /\{\{(\w+)\}\}/.exec(EN[PLACEHOLDER_KEY])[0];
const exempt = allowedEntries();
const SENTENCE_KEY = keyWhere(
  (key, v) =>
    v.trim().split(/\s+/).length >= 4 && v.length >= 20 && !/\{\{/.test(v) && ZH[key] !== v && !exempt.has(`${NS}:${key}`),
  "a translated sentence",
);

/** The first `key: "value"` line of en.yml whose value has a `%{name}` placeholder. */
const EN_YML = readFileSync(path.join(REPO, "src-tauri/locales/en.yml"), "utf8").split("\n");
const ymlLine = (lines, key) => lines.findIndex((l) => l.trimStart().startsWith(`${key}:`));
const YML_PLACEHOLDER_KEY = /^\s*([A-Za-z0-9_.-]+):.*%\{\w+\}/.exec(EN_YML.find((l) => /^\s*[A-Za-z0-9_.-]+:.*%\{\w+\}/.test(l)))[1];
const YML_ANY_KEY = /^\s*([A-Za-z0-9_.-]+):\s*\S/.exec(EN_YML.find((l) => /^\s*[A-Za-z0-9_.-]+:\s*["'A-Za-z]/.test(l)))[1];

describe("check-i18n-keys.ts — the unmodified tree", () => {
  it("passes on a copy of the real locale files", () => {
    const r = run(scratch());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("All i18n checks passed.");
  });
});

describe("check-i18n-keys.ts — key completeness", () => {
  it("a key missing from one translation fails and is named", () => {
    const root = scratch();
    editJson(root, NS, (d) => delete d[ANY_KEY]);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`[ERROR] ${NS}`);
    expect(r.out).toContain(`1 missing: ${ANY_KEY}`);
    expect(r.out).toContain("i18n check FAILED.");
  });

  it("a new English key with no translation fails in every language", () => {
    const root = scratch();
    editJson(root, "src/locales/en/common.json", (d) => { d["zzFixture.newThing"] = "Brand new"; });
    const r = run(root);
    expect(r.status).toBe(1);
    for (const lang of ["de", "ja", LANG]) expect(r.out).toContain(`[ERROR] src/locales/${lang}/common.json`);
    expect(r.out).toContain("zzFixture.newThing");
  });

  it("a namespace file missing from a language that has the others fails", () => {
    const root = scratch();
    rmSync(path.join(root, NS));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${NS} — MISSING FILE`);
  });

  it("a key that exists only in a translation is a warning, not a failure", () => {
    const root = scratch();
    editJson(root, NS, (d) => { d["zzFixture.onlyHere"] = "多余"; });
    const r = run(root);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("1 extra key: zzFixture.onlyHere");
  });

  it("a legacy plural suffix in English fails", () => {
    const root = scratch();
    editJson(root, "src/locales/en/common.json", (d) => { d["zzFixture.items_plural"] = "items"; });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("dead legacy plural suffix");
    expect(r.out).toContain("zzFixture.items_plural");
  });

  it("a key missing from a YAML translation fails", () => {
    const root = scratch();
    editText(root, `src-tauri/locales/${YML}`, (text) => {
      const lines = text.split("\n");
      const at = ymlLine(lines, YML_ANY_KEY);
      if (at === -1) throw new Error(`fixture: ${YML_ANY_KEY} not in ${YML}`);
      lines.splice(at, 1);
      return lines.join("\n");
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`[ERROR] src-tauri/locales/${YML}`);
    expect(r.out).toContain(YML_ANY_KEY);
  });

  it("an unparseable translation file fails", () => {
    const root = scratch();
    writeFileSync(path.join(root, NS), "{ not json");
    const r = run(root);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("All i18n checks passed.");
  });

  it("an unparseable ENGLISH file fails rather than comparing against no keys", () => {
    const root = scratch();
    writeFileSync(path.join(root, "src/locales/en/common.json"), "{ not json");
    const r = run(root);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("All i18n checks passed.");
  });
});

describe("check-i18n-keys.ts — values", () => {
  it("a translation that dropped a {{placeholder}} fails and says which", () => {
    const root = scratch();
    editJson(root, NS, (d) => { d[PLACEHOLDER_KEY] = d[PLACEHOLDER_KEY].replace(PLACEHOLDER, "X"); });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("placeholder mismatch");
    expect(r.out).toContain(`${PLACEHOLDER_KEY}: missing ${PLACEHOLDER}`);
  });

  it("a translation that invented a {{placeholder}} fails", () => {
    const root = scratch();
    editJson(root, NS, (d) => { d[ANY_KEY] = `${d[ANY_KEY]} {{zzNope}}`; });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${ANY_KEY}: extra {{zzNope}}`);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a number", 7],
    ["null", null],
  ])("a translation whose value is %s fails — the key exists but nothing would render", (_label, value) => {
    const root = scratch();
    editJson(root, NS, (d) => { d[ANY_KEY] = value; });
    const r = run(root);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${ANY_KEY}: empty or non-string value`);
  });

  it("a YAML translation that dropped a %{placeholder} fails", () => {
    const root = scratch();
    editText(root, `src-tauri/locales/${YML}`, (text) => {
      const lines = text.split("\n");
      const at = ymlLine(lines, YML_PLACEHOLDER_KEY);
      if (at === -1) throw new Error(`fixture: ${YML_PLACEHOLDER_KEY} not in ${YML}`);
      lines[at] = lines[at].replace(/%\{\w+\}/, "X");
      return lines.join("\n");
    });
    const r = run(root);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`src-tauri/locales/${YML}`);
    expect(r.out).toContain(`${YML_PLACEHOLDER_KEY}: missing %{`);
  });

  it("an empty YAML translation value fails", () => {
    const root = scratch();
    editText(root, `src-tauri/locales/${YML}`, (text) => {
      const lines = text.split("\n");
      const at = ymlLine(lines, YML_ANY_KEY);
      lines[at] = lines[at].replace(/:.*$/, ': ""');
      return lines.join("\n");
    });
    const r = run(root);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`${YML_ANY_KEY}: empty value`);
  });

  it("a sentence copied over in English fails as untranslated", () => {
    const root = scratch();
    editJson(root, NS, (d) => { d[SENTENCE_KEY] = EN[SENTENCE_KEY]; });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("1 value(s) left in English");
    expect(r.out).toContain(`${NS}:${SENTENCE_KEY}`);
  });

  it("a missing untranslated-baseline file fails instead of assuming an empty one", () => {
    const root = scratch();
    rmSync(path.join(root, "scripts/i18n-untranslated-baseline.json"));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("i18n-untranslated-baseline.json missing");
  });

  it("a stale untranslated-baseline entry fails until the win is recorded", () => {
    const root = scratch();
    editJson(root, "scripts/i18n-untranslated-baseline.json", (d) => { d.entries = [`${NS}:${SENTENCE_KEY}`]; });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("1 baselined value(s) now translated");
  });
});

describe("check-i18n-keys.ts — copy conventions and dialogs", () => {
  /** Add a key to English and a distinct translation to every other language. */
  function addEverywhere(root, key, english) {
    for (const lang of readdirSync(path.join(root, "src/locales")).filter((d) => !d.startsWith("__"))) {
      const rel = `src/locales/${lang}/common.json`;
      if (!existsSync(path.join(root, rel))) continue;
      editJson(root, rel, (d) => { d[key] = lang === "en" ? english : `${lang} 翻译`; });
    }
  }

  it("a new English string with three dots fails the copy conventions", () => {
    const root = scratch();
    addEverywhere(root, "zzFixture.loading", "Loading...");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("NEW copy-convention violation");
    expect(r.out).toContain("common.json:zzFixture.loading:ellipsis");
  });

  it("the same string with a real ellipsis passes", () => {
    const root = scratch();
    addEverywhere(root, "zzFixture.loading", "Loading…");
    const r = run(root);
    expect(r.status, r.out).toBe(0);
  });

  it("a missing copy baseline fails", () => {
    const root = scratch();
    rmSync(path.join(root, "scripts/i18n-copy-baseline.json"));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("copy-convention baseline missing");
  });

  it("a hardcoded English toast in a source file fails", () => {
    const root = scratch();
    mkdirSync(path.join(root, "src/zzFixture"), { recursive: true });
    writeFileSync(
      path.join(root, "src/zzFixture/save.ts"),
      'import { toast } from "sonner";\nexport const done = () => toast.success("Saved the file");\n',
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("hardcoded/raw dialog call(s)");
    expect(r.out).toContain("src/zzFixture/save.ts");
  });

  it("a registered fragment site that no longer exists fails", () => {
    const root = scratch();
    const [first] = Object.values(REGISTERED_FRAGMENTS);
    rmSync(path.join(root, first.files[0]));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${first.files[0]}: registered for fragment`);
  });
});
