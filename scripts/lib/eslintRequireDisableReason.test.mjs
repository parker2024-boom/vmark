// WI-RA17F.7 — an eslint-disable directive without a ` -- reason` is a lint error.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it, expect } from "vitest";
import { Linter, RuleTester } from "eslint";
import { lacksReason, requireDisableReason } from "./eslintRequireDisableReason.mjs";
import { gitIn, repoFiles } from "./featureMapInputs.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });
const missing = [{ messageId: "missing" }];

tester.run("require-disable-reason", requireDisableReason, {
  valid: [
    "// eslint-disable-next-line no-console -- the CLI prints its report\nconsole.log(1);",
    "const a = 1; // eslint-disable-line no-unused-vars -- kept for the public shape",
    "/* eslint-disable no-console -- a debug dump module */\nconsole.log(1);\n/* eslint-enable no-console */",
    "/* eslint-disable-next-line no-console -- block form with a reason */\nconsole.log(1);",
    "// eslint-disable-next-line no-console --- a longer separator is still a separator\nconsole.log(1);",
    // Enabling suppresses nothing, so it needs no reason.
    "/* eslint-enable no-console */",
    // Prose that mentions a directive is not a directive.
    "// The fix was not an eslint-disable; it was a refactor.",
    "// see eslint-disable-next-line docs",
    // Unicode / CJK reasons are reasons.
    "// eslint-disable-next-line no-console -- 调试输出\nconsole.log(1);",
  ],
  invalid: [
    { code: "// eslint-disable-next-line no-console\nconsole.log(1);", errors: missing },
    { code: "const a = 1; // eslint-disable-line no-unused-vars", errors: missing },
    { code: "/* eslint-disable no-console */\nconsole.log(1);", errors: missing },
    { code: "/* eslint-disable-next-line no-console */\nconsole.log(1);", errors: missing },
    // An empty or whitespace-only description is no description.
    {
      code: "// eslint-disable-next-line no-console --\nconsole.log(1);",
      // ESLint itself reads the trailing `--` as part of the rule name.
      errors: [{ message: "Definition for rule 'no-console --' was not found." }, ...missing],
    },
    { code: "// eslint-disable-next-line no-console --   \nconsole.log(1);", errors: missing },
    // `--` glued to the rule name is part of the name, not a separator.
    {
      code: "// eslint-disable-next-line no-console--why\nconsole.log(1);",
      errors: [{ message: "Definition for rule 'no-console--why' was not found." }, ...missing],
    },
    // Every offending directive is reported, not just the first.
    {
      code: "// eslint-disable-next-line no-console\nconsole.log(1);\n// eslint-disable-next-line no-console\nconsole.log(2);",
      errors: [{ messageId: "missing", line: 1 }, { messageId: "missing", line: 3 }],
    },
  ],
});

describe("lacksReason", () => {
  it.each([
    ["eslint-disable-next-line a", true],
    ["eslint-disable-line a", true],
    ["eslint-disable a, b", true],
    // A blanket disable silences the rule itself, so only this scan sees it.
    ["eslint-disable", true],
    ["eslint-disable -- ", true],
    ["eslint-disable a -- why", false],
    ["eslint-disable a -- 原因", false],
    ["eslint-enable a", false],
    ["eslint-disabled is not a directive", false],
    ["see eslint-disable-next-line docs", false],
    ["", false],
  ])("%j -> %s", (value, expected) => {
    expect(lacksReason(value)).toBe(expected);
  });
});

/** Directive comments in `text`: line comments, and block comments up to their close. */
function directiveComments(text) {
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /(\/\/|\/\*)\s*(eslint-disable[\s\S]*)$/u.exec(lines[i]);
    if (!m) continue;
    let value = m[2];
    if (m[1] === "/*") {
      let j = i;
      while (!value.includes("*/") && j + 1 < lines.length) value += "\n" + lines[++j];
      value = value.slice(0, value.indexOf("*/"));
    }
    found.push({ line: i + 1, value });
  }
  return found;
}

/**
 * The source files git sees under `dir` (tracked, or new and not ignored).
 * Not a disk walk: gitignored scratch trees such as a Stryker sandbox are
 * created and deleted by other tests while this one runs, and a walk read a
 * file in one after it had gone (ENOENT). Ignored files are not ours anyway.
 */
function sourceFiles(dir) {
  const prefix = `${relative(ROOT, dir).split(sep).join("/")}/`;
  return repoFiles(ROOT, gitIn(ROOT))
    .filter((f) => f.startsWith(prefix) && /\.(?:[cm]?[jt]sx?)$/u.test(f))
    .map((f) => join(ROOT, f));
}

/**
 * Every tree whose code is ours. The server packages lint under the root
 * config; scripts and e2e are not linted, so this scan is their only check.
 */
const SCANNED = ["src", "server/content/src", "server/mcp/src", "server/mcp/__tests__", "scripts", "e2e"];
/** This rule's own module and test quote directives as data. */
const SELF = new Set(["scripts/lib/eslintRequireDisableReason.mjs", "scripts/lib/eslintRequireDisableReason.test.mjs"]);

describe("the source tree", () => {
  it("finds directives the way the rule does (scanner self-check)", () => {
    const found = directiveComments(
      "a; // eslint-disable-line x\n/* eslint-disable y\n   -- spans lines */\nconst u = \"https://x\";\n",
    );
    expect(found.map((f) => [f.line, lacksReason(f.value)])).toEqual([[1, true], [2, false]]);
  });

  it("has no eslint-disable directive without a reason in any tree of ours", () => {
    const files = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).filter(
      (file) => !SELF.has(relative(ROOT, file).split(sep).join("/")),
    );
    expect(files.length).toBeGreaterThan(1000);
    const offenders = files.flatMap((file) =>
      directiveComments(readFileSync(file, "utf8"))
        .filter((d) => lacksReason(d.value))
        .map((d) => `${relative(ROOT, file)}:${d.line}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("wired into the real config", () => {
  it("a reasonless directive in an app source file fails `pnpm lint`", async () => {
    const { default: config } = await import("../../eslint.config.js");
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      "// eslint-disable-next-line prefer-const\nlet a = 1;\nexport { a };\n",
      config,
      { filename: "src/utils/example.ts" },
    );
    expect(messages.map((m) => m.ruleId)).toContain("vmark/require-disable-reason");
    expect(messages.find((m) => m.ruleId === "vmark/require-disable-reason")?.severity).toBe(2);
  });

  it("reports an unused disable directive as an error", async () => {
    const { default: config } = await import("../../eslint.config.js");
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      "// eslint-disable-next-line prefer-const -- stale\nexport const a = 1;\n",
      config,
      { filename: "src/utils/example.ts" },
    );
    const unused = messages.filter((m) => m.ruleId === null && /Unused eslint-disable/.test(m.message));
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe(2);
  });
});
