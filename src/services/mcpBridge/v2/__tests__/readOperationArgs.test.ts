// @vitest-environment node
// WI-15 — the webview's single typed parse of a wire payload.
/**
 * This replaced the per-field `typeof` chains in `document.write` and
 * `selection.set`, so its coercion has to match them EXACTLY — a field of the
 * wrong runtime shape reads as absent, and the handler's own guard decides
 * what absence means. Anything stricter would change behaviour under the
 * banner of de-duplication.
 *
 * Ledger D5: an undeclared field is logged loudly, never silently dropped.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readOperationArgs, readOperationArgsChecked } from "@/services/mcpBridge/v2/readOperationArgs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readOperationArgs", () => {
  it("keeps declared fields that match their declared kind", () => {
    expect(
      readOperationArgs("vmark.document.write", {
        tabId: "t1",
        content: "# hi",
        expected_revision: "r1",
        save: false,
      }),
    ).toEqual({ tabId: "t1", content: "# hi", expected_revision: "r1", save: false });
  });

  it("drops a declared field carrying the wrong runtime shape", () => {
    expect(
      readOperationArgs("vmark.document.write", {
        tabId: 42,
        content: "# hi",
        save: "yes",
      }),
    ).toEqual({ content: "# hi" });
  });

  it("keeps an empty string and `false` — absent is not the same as falsy", () => {
    expect(readOperationArgs("vmark.document.write", { content: "", save: false })).toEqual({
      content: "",
      save: false,
    });
  });

  it("preserves CJK and astral content byte-for-byte", () => {
    const content = "# 中文标题\n\n第一段 — with 😀 and \u0000 nul";
    expect(readOperationArgs("vmark.selection.set", { content }).content).toBe(content);
  });

  it("rejects a non-finite number for a numeric field", () => {
    expect(readOperationArgs("vmark.browser.act", { operation: "scroll", dy: NaN })).toEqual({
      operation: "scroll",
    });
    expect(readOperationArgs("vmark.browser.act", { operation: "scroll", dy: 0 })).toEqual({
      operation: "scroll",
      dy: 0,
    });
  });

  it("treats an array as an array and never as an object", () => {
    expect(
      readOperationArgs("vmark.workflow.apply_patch", { patches: [{ op: "x" }] }).patches,
    ).toEqual([{ op: "x" }]);
    expect(readOperationArgs("vmark.workflow.apply_patch", { patches: { a: 1 } })).toEqual({});
    expect(readOperationArgs("vmark.browser.act", { operation: "key", modifiers: [] })).toEqual({
      operation: "key",
    });
    expect(readOperationArgs("vmark.browser.act", { operation: "key", modifiers: null })).toEqual({
      operation: "key",
    });
  });

  it("accepts any shape for an `unknown` field, including null", () => {
    expect(
      readOperationArgs("vmark.browser.query", { selector: ".a", fields: null }),
    ).toEqual({ selector: ".a", fields: null });
  });

  it("returns nothing for an empty payload rather than throwing", () => {
    expect(readOperationArgs("vmark.document.read", {})).toEqual({});
  });

  it("logs — loudly and by name — a field the contract does not declare", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = readOperationArgs("vmark.workspace.open", {
      filePath: "/w/a.md",
      windowId: "doc-2",
      clientId: "codex",
    });
    expect(parsed).toEqual({ filePath: "/w/a.md" });
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("windowId");
    expect(logged).toContain("clientId");
    expect(logged).toContain("vmark.workspace.open");
  });

  it("stays quiet when every field is declared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readOperationArgs("vmark.workspace.open", { filePath: "/w/a.md", windowLabel: "doc-1" });
    expect(warn).not.toHaveBeenCalled();
  });
});

// WI-RA18.8 — the checked read: the same parse, plus the declared fields that
// arrived with the wrong runtime shape, for a handler that must refuse one
// rather than read it as absent.
describe("readOperationArgsChecked", () => {
  it("parses exactly as readOperationArgs does", () => {
    const args = { tabId: 42, content: "# hi", save: "yes", expected_revision: "r1" };
    expect(readOperationArgsChecked("vmark.document.write", args).wire).toEqual(
      readOperationArgs("vmark.document.write", args),
    );
  });

  it("names the declared fields that were present with the wrong shape", () => {
    const { malformed } = readOperationArgsChecked("vmark.browser.style", {
      tabId: "",
      set: ["color", "red"],
      addClasses: "big",
      injectCss: 7,
      selector: "p",
    });
    expect([...malformed].sort()).toEqual(["addClasses", "injectCss", "set"]);
  });

  it.each([
    ["null", null],
    ["a number", 5],
    ["an object", { id: "t1" }],
  ])("reports a tab id given as %s", (_label, tabId) => {
    expect(readOperationArgsChecked("vmark.browser.read", { tabId }).malformed.has("tabId")).toBe(true);
  });

  it("reports nothing for an absent field, and a non-finite number as malformed", () => {
    expect(readOperationArgsChecked("vmark.browser.wait_for", {}).malformed.size).toBe(0);
    expect(
      readOperationArgsChecked("vmark.browser.wait_for", { timeoutMs: Number.NaN }).malformed.has("timeoutMs"),
    ).toBe(true);
  });

  it("does not report an undeclared field as malformed — that is logged, not refused", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readOperationArgsChecked("vmark.browser.read", { clientId: 1 }).malformed.size).toBe(0);
  });
});
