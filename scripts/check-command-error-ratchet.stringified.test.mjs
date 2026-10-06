// WI-RA13B.7 — the frontend half of the CommandError ratchet: typed command
// errors must not be stringified, and `command-error-ok` exemptions stay frozen.
/**
 * WI-DP2.7 — pure-function cases for `typedCommandNames` and
 * `findStringifiedTypedErrors`, plus the frozen identity list of
 * `// command-error-ok:` exemptions. Split out of
 * check-command-error-ratchet.test.mjs to keep both suites under the test-file
 * size limit; the end-to-end wiring case for this check stays there, beside the
 * subprocess fixtures it uses. No mocking: every case parses real source text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findStringifiedTypedErrors, typedCommandNames } from "./check-command-error-ratchet.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── WI-DP2.7: typed commands must not be stringified in the frontend ───
//
// A `CommandError` serialises as a plain OBJECT, so `String(error)` on one
// renders the literal "[object Object]". This shipped to users at four
// boundaries before it was caught by hand (WI-DP2.6). With ~49 conversions
// still to go, every one of them can reintroduce it — so the ratchet that
// drives those conversions is also the thing that has to assert against it.

describe("typedCommandNames", () => {
  it("names commands returning CommandError, and not the legacy ones", () => {
    const source = `
      #[tauri::command]
      pub fn typed_one(app: AppHandle) -> Result<(), CommandError> { Ok(()) }

      #[tauri::command]
      pub async fn legacy_one() -> Result<String, String> { Ok(String::new()) }

      #[tauri::command(rename_all = "snake_case")]
      pub fn typed_two() -> Result<Vec<u8>, crate::command_error::CommandError> { Ok(vec![]) }
    `;
    expect(typedCommandNames(source).sort()).toEqual(["typed_one", "typed_two"]);
  });

  it("ignores a command name that appears only inside a comment", () => {
    const source = `
      // #[tauri::command] pub fn ghost() -> Result<(), CommandError> {}
      #[tauri::command]
      pub fn real() -> Result<(), CommandError> { Ok(()) }
    `;
    expect(typedCommandNames(source)).toEqual(["real"]);
  });
});

describe("findStringifiedTypedErrors", () => {
  const typed = new Set(["hot_exit_capture"]);

  // audit R2 #26 — the parser's script kind came from `file.includes(".ts")`,
  // which is FALSE for `foo.mts` and `foo.cts`. Both are scanned by
  // FRONTEND_SOURCE, so every ESM/CJS TypeScript module was handed to the
  // parser as JavaScript; a type annotation is then a syntax error and the
  // recovered tree hid the defect. The subject is a construct only the TS
  // parser accepts.
  it.each(["src/x.mts", "src/x.cts", "src/x.ts"])("parses %s as TypeScript, not JavaScript", (file) => {
    const source = [
      'import { invoke } from "@tauri-apps/api/core";',
      "export async function go(): Promise<void> {",
      "  try {",
      '    await invoke<Record<string, unknown>>("hot_exit_capture");',
      "  } catch (e) {",
      "    console.error(String(e));",
      "  }",
      "}",
    ].join("\n");
    expect(findStringifiedTypedErrors([{ path: file, source }], typed)).toEqual([
      expect.objectContaining({ file, command: "hot_exit_capture" }),
    ]);
  });

  // audit R2 #24 — Tauri's `invoke` is a bare imported identifier; a method of
  // that name on an unrelated object (src/test/statefulFsFake.ts has one) armed
  // the gate on a file that invokes no command.
  it("ignores a receiver call named invoke", () => {
    const file = {
      path: "src/x.ts",
      source: [
        "const fs = { invoke: (c: string) => c };",
        "try { fs.invoke(\"hot_exit_capture\"); } catch (e) { report(String(e)); }",
      ].join("\n"),
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  // audit R2 #22 — a reassignable binding is not a compile-time constant.
  it("does not resolve a command name through a reassignable let", () => {
    const file = {
      path: "src/y.ts",
      source: [
        'import { invoke } from "@tauri-apps/api/core";',
        'let cmd = "hot_exit_capture";',
        'cmd = "something_else";',
        "try { await invoke(cmd); } catch (e) { report(String(e)); }",
      ].join("\n"),
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("leaves a name declared twice with different values unresolved", () => {
    const file = {
      path: "src/z.ts",
      source: [
        'import { invoke } from "@tauri-apps/api/core";',
        'function a() { const cmd = "hot_exit_capture"; return cmd; }',
        'function b() { const cmd = "unrelated_command"; return cmd; }',
        'const cmd = "unrelated_command";',
        "try { await invoke(cmd); } catch (e) { report(String(e)); }",
      ].join("\n"),
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("flags a file that invokes a typed command and stringifies its error", () => {
    const file = {
      path: "src/pages/settings/X.tsx",
      source: `const r = await invoke("hot_exit_capture");
               } catch (error) { setError(String(error)); }`,
    };
    const hits = findStringifiedTypedErrors([file], typed);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "src/pages/settings/X.tsx", command: "hot_exit_capture" });
  });

  // `errorMessage()` is literally `error instanceof Error ? … : String(error)`,
  // so it carries the identical defect under a different name — and rule 50 §10
  // names it explicitly. Catching only the `String(...)` spelling would leave
  // the same bug reachable by import.
  it("flags the errorMessage() helper too, not just String()", () => {
    const file = {
      path: "src/x.ts",
      source: `import { errorMessage } from "@/utils/errorMessage";
               await invoke("hot_exit_capture");
               } catch (error) { warn(errorMessage(error)); }`,
    };
    const hits = findStringifiedTypedErrors([file], typed);
    expect(hits).toHaveLength(1);
  });

  // The check is FILE-level: it cannot tell which error a helper was applied to.
  // `shortcuts.ts` invokes a typed command AND stringifies a JSON.parse failure,
  // which is correct. House pattern for that (i18n allowlist, focus caret-only):
  // a marker carrying a REASON, because an unexplained suppression is a mute
  // button.
  // Audit 20260809 #1 — `<[^>]*>` stopped at the FIRST `>`, so a nested generic
  // was invisible. `browserHelpers.ts` uses exactly this form for a typed
  // command, so the gate had a real false negative on a real file.
  it("matches invoke with NESTED generics", () => {
    const file = {
      path: "src/nested.ts",
      source: `await invoke<Record<string, unknown>>("hot_exit_capture");
               } catch (error) { show(String(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  // Audit 20260809 #4 — only `e`/`err`/`error` were recognised.
  // Verify round 1 (#1 REGRESSED) — a one-level regex is not "balanced".
  it.each([
    ['invoke<Record<string, Array<unknown>>>("hot_exit_capture")', "deep nesting"],
    ['invoke<(string)>("hot_exit_capture")', "parenthesised type"],
    ['invoke<Record<string, unknown>>("hot_exit_capture")', "one level"],
    ['invoke("hot_exit_capture")', "no generic"],
    ['invoke<string>("hot_exit_capture")', "simple generic"],
  ])("matches %s (%s)", (call) => {
    const file = { path: "src/g.ts", source: `${call};\n} catch (error) { show(String(error)); }` };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  // Verify round 1 (#4 REGRESSED) — catch names were collected file-wide, so an
  // unrelated String(reason) was blamed on a catch(reason) somewhere else.
  // Verify rounds 1-2 kept finding new lexer edge cases — the mechanism was
  // hand-rolled lexing, so the class is fixed by parsing a real TS AST (the
  // house pattern: check-mock-boundaries, check-shell-slots, and
  // check-hooks-react-purity all do this). Every case below is one the
  // verifier named.
  const flagged = (source, path = "src/edge.ts") =>
    findStringifiedTypedErrors([{ path, source }], typed).length;

  it.each([
    ['invoke<{ value: string }>("hot_exit_capture")', "object type argument"],
    ['invoke<(value: string) => Record<string, unknown>>("hot_exit_capture")', "function type"],
    ['invoke<Record<string, Array<unknown>>>("hot_exit_capture")', "deep nesting"],
    ['invoke<(string)>("hot_exit_capture")', "parenthesised type"],
  ])("detects %s (%s)", (call) => {
    expect(flagged(`${call};\ntry { a(); } catch (error) { show(String(error)); }`)).toBe(1);
  });

  // `invoke < b > ("x")` is NOT ambiguous once a parser is involved: TypeScript
  // itself resolves it to a CallExpression with a type argument (verified
  // against ts.createSourceFile). Agreeing with the language's own parse is the
  // correct behaviour, so this pins that the gate does — the regex-era worry
  // about "relational expressions" does not survive contact with the AST.
  it("follows TypeScript's own parse of the ambiguous `a < b > (c)` form", () => {
    expect(flagged('const t = invoke < b > ("hot_exit_capture");\ntry{a()}catch(e){show(String(e))}')).toBe(1);
  });

  it("is not fooled by a brace inside a string in the catch body", () => {
    expect(flagged('await invoke("hot_exit_capture");\ntry { a(); } catch (e) { log("}"); show(String(e)); }')).toBe(1);
  });

  it("handles .catch(async (e) => ...)", () => {
    expect(flagged('await invoke("hot_exit_capture").catch(async (e) => show(String(e)));')).toBe(1);
  });

  // audit R2 #25 — `.then(onFulfilled, onRejected)` is the other Promise
  // rejection-handler form; only `.catch` was recognised, so this stringified
  // a typed CommandError with the gate silent.
  it("handles the second argument of .then(onFulfilled, onRejected)", () => {
    expect(flagged('invoke("hot_exit_capture").then((v) => use(v), (e) => show(String(e)));')).toBe(1);
    expect(flagged('invoke("hot_exit_capture").then((v) => use(v), (e) => show(commandErrorMessage(e)));')).toBe(0);
    // The FULFILLED argument is not a rejection binding — `String(v)` on a
    // resolved value is ordinary code.
    expect(flagged('invoke("hot_exit_capture").then((v) => show(String(v)));')).toBe(0);
  });

  it("respects shadowing by an inner function parameter", () => {
    expect(
      flagged(
        'await invoke("hot_exit_capture");\ntry { a(); } catch (e) { const f = (e) => String(e); f(1); }',
      ),
    ).toBe(0);
  });

  // Verify round 3 — the REAL false negative, not a theoretical one. Command
  // names reach `invoke()` through a `const … as const` map in
  // src/services/persistence/hotExit/restartWithHotExit.ts, and that file was
  // stringifying a rejection from the typed `hot_exit_capture` where the gate
  // could not see it. Requiring a string LITERAL argument made the gate blind
  // to exactly the module family an [object Object] bug had already been found in.
  it("resolves a command name held in a const map, not just a literal argument", () => {
    const file = {
      path: "src/consts.ts",
      source: `const CMDS = { CAPTURE: "hot_exit_capture" } as const;
               try { await invoke(CMDS.CAPTURE); } catch (error) { show(String(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  it("resolves a command name held in a plain const", () => {
    const file = {
      path: "src/const2.ts",
      source: `const CMD = "hot_exit_capture";
               try { await invoke(CMD); } catch (error) { show(String(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  it("does not invent a typed command from an unrelated literal", () => {
    const file = {
      path: "src/unrelated.ts",
      source: `const LABEL = "hot_exit_capture is the name";
               try { await invoke(someVar); } catch (error) { show(String(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("does NOT flag a stringify outside the catch block that binds that name", () => {
    const file = {
      path: "src/scoped.ts",
      source: `await invoke("hot_exit_capture");
               try { a(); } catch (reason) { logIt(reason); }
               function unrelated(reason) { return String(reason); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("still flags a stringify INSIDE the catch block", () => {
    const file = {
      path: "src/inside.ts",
      source: `await invoke("hot_exit_capture");
               try { a(); } catch (reason) { show(String(reason)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  it("detects a catch binding under any name", () => {
    const file = {
      path: "src/named.ts",
      source: `await invoke("hot_exit_capture");
               } catch (reason) { show(String(reason)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  it("still ignores String() on a non-error value", () => {
    const file = {
      path: "src/value.ts",
      source: `await invoke("hot_exit_capture");
               const label = String(count) + String(42);`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("honours `command-error-ok:` with a reason", () => {
    const file = {
      path: "src/parse.ts",
      source: `await invoke("hot_exit_capture");
               // command-error-ok: this is a JSON.parse failure, not the invoke's rejection
               } catch (e) { report(errorMessage(e)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  // Audit 20260809 #3 — one marker used to suppress the ENTIRE file, so the
  // shortcuts.ts exemption also hid that file's typed invoke. Scope it to the
  // marked region: a LATER unmarked violation in the same file must still fail.
  it("a marker suppresses only its own site, not the whole file", () => {
    const file = {
      path: "src/mixed.ts",
      source: `await invoke("hot_exit_capture");
               // command-error-ok: this one is a JSON.parse failure
               } catch (e) { report(errorMessage(e)); }
               function later() {
                 try { doThing(); } catch (e2) { report(String(e2)); }
               }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  it("REJECTS a bare marker with no reason", () => {
    const file = {
      path: "src/bare.ts",
      source: `await invoke("hot_exit_capture");
               // command-error-ok:
               } catch (e) { report(errorMessage(e)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toHaveLength(1);
  });

  it("does NOT flag commandErrorMessage, whose name contains errorMessage", () => {
    const file = {
      path: "src/y.ts",
      source: `await invoke("hot_exit_capture");
               } catch (error) { warn(commandErrorMessage(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("does NOT flag a file that already routes through commandErrorMessage", () => {
    const file = {
      path: "src/ok.ts",
      source: `import { commandErrorMessage } from "@/services/commands/commandError";
               await invoke("hot_exit_capture");
               } catch (error) { setError(commandErrorMessage(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("does NOT flag stringification in a file that only invokes LEGACY commands", () => {
    // `String(error)` is CORRECT while the command still returns Result<T, String>.
    // Flagging it would make the gate demand a change that is wrong today.
    const file = {
      path: "src/legacy.ts",
      source: `await invoke("print_document");
               } catch (error) { fail(String(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("does NOT flag String() applied to something that is not a caught error", () => {
    const file = {
      path: "src/other.ts",
      source: `await invoke("hot_exit_capture");
               const label = String(count);`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });

  it("treats a typed command named only in a comment as not invoked", () => {
    const file = {
      path: "src/commented.ts",
      source: `// once we call invoke("hot_exit_capture") this will matter
               } catch (error) { setError(String(error)); }`,
    };
    expect(findStringifiedTypedErrors([file], typed)).toEqual([]);
  });
});

// A `// command-error-ok:` marker is a SUPPRESSION with no allowlist file to
// review — nothing stopped a second one appearing quietly, which is the same
// move as adding a baseline entry, minus the diff a reviewer would see. This
// freezes the identity list in both directions, the house standard: a new
// exemption fails, and removing one fails until the win is recorded here.
describe("command-error-ok exemptions are a frozen identity list", () => {
  const EXEMPT_FILES = ["src/stores/settingsStore/shortcuts.ts"];

  /** Every non-test file under src/ carrying the marker. */
  function markedFiles(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") markedFiles(full, out);
      } else if (
        /\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(entry.name) &&
        !/\.(?:test|spec)\./.test(entry.name) &&
        readFileSync(full, "utf8").includes("command-error-ok:")
      ) {
        out.push(path.relative(REPO, full).split(path.sep).join("/"));
      }
    }
    return out;
  }

  it("matches the documented set exactly", () => {
    expect(markedFiles(path.join(REPO, "src")).sort()).toEqual([...EXEMPT_FILES].sort());
  });

  it("every marker states a reason — a bare one is a mute button", () => {
    for (const rel of EXEMPT_FILES) {
      const lines = readFileSync(path.join(REPO, rel), "utf8").split("\n");
      const marked = lines.filter((l) => l.includes("command-error-ok:"));
      expect(marked.length).toBeGreaterThan(0);
      for (const line of marked) {
        expect(line).toMatch(/\/\/[^\S\n]*command-error-ok:[^\S\n]*\S/);
      }
    }
  });
});
