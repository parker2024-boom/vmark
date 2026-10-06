// @vitest-environment node
// WI-RA9A.10 — the two popup base classes expose the same subclass hooks.
/**
 * SourcePopupView and WysiwygPopupView are twins: one lifecycle, two editors.
 * A hook added to one and not the other makes the same popup behave
 * differently per mode (the click-outside commit hook reached Source long
 * before WYSIWYG). This test reads both class declarations and fails when the
 * sets of subclass-visible members differ by anything not listed, with its
 * reason, in EDITOR_SPECIFIC below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const WYSIWYG = { file: join(ROOT, "shared/WysiwygPopupView.ts"), className: "WysiwygPopupView" };
const SOURCE = { file: join(ROOT, "shared/SourcePopupView.ts"), className: "SourcePopupView" };

/**
 * Members one base has and the other does not, each with the reason it is
 * allowed. An entry here is a claim that the difference is deliberate; the
 * parity tests compare against this list exactly, so an entry that stops
 * being true fails too and the list cannot rot.
 */
const EDITOR_SPECIFIC: Record<"wysiwygOnly" | "sourceOnly", Record<string, string>> = {
  wysiwygOnly: {
    createShell:
      "DOM construction helper, not a lifecycle hook: Source popups set their `popup-container` class inline in buildContainer().",
    getFirstFocusable:
      "Focus-on-show veto, WYSIWYG shape: the subclass returns the element to focus, or null to leave focus in the document. Source expresses the same veto as shouldFocusOnShow (paired below).",
  },
  sourceOnly: {
    shouldFocusOnShow:
      "Focus-on-show veto, Source shape: CodeMirror needs the focus move deferred past its own click handling and re-checked against the store when it runs, so the veto is a predicate over state rather than an element getter.",
  },
};

/** Each side's name for a concern both must keep. */
const PAIRED_HOOKS: Array<{ concern: string; wysiwyg: string; source: string }> = [
  { concern: "focus-on-show veto", wysiwyg: "getFirstFocusable", source: "shouldFocusOnShow" },
];

interface Member {
  name: string;
  visibility: "public" | "protected";
  isAbstract: boolean;
}

/** Methods a subclass can see (protected or public) on the named class. */
function subclassVisibleMethods(target: { file: string; className: string }): Map<string, Member> {
  const sourceFile = ts.createSourceFile(
    target.file,
    readFileSync(target.file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const members = new Map<string, Member>();
  let found = false;
  sourceFile.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== target.className) return;
    found = true;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const kinds = new Set((member.modifiers ?? []).map((m) => m.kind));
      if (kinds.has(ts.SyntaxKind.PrivateKeyword)) continue;
      members.set(member.name.text, {
        name: member.name.text,
        visibility: kinds.has(ts.SyntaxKind.ProtectedKeyword) ? "protected" : "public",
        isAbstract: kinds.has(ts.SyntaxKind.AbstractKeyword),
      });
    }
  });
  if (!found) throw new Error(`class ${target.className} not found in ${target.file}`);
  return members;
}

const wysiwyg = subclassVisibleMethods(WYSIWYG);
const source = subclassVisibleMethods(SOURCE);
const only = (a: Map<string, Member>, b: Map<string, Member>) =>
  [...a.keys()].filter((name) => !b.has(name)).sort();

describe("popup base pair — subclass hook parity", () => {
  it("reads a real hook surface from both classes", () => {
    // Guards the parser: an empty set would make every check below pass vacuously.
    for (const members of [wysiwyg, source]) {
      expect(members.size).toBeGreaterThanOrEqual(10);
      for (const required of ["buildContainer", "onShow", "onHide", "onClickOutside", "destroy"]) {
        expect([...members.keys()]).toContain(required);
      }
    }
  });

  it("WysiwygPopupView has no hook that SourcePopupView lacks, beyond the reasoned list", () => {
    expect(only(wysiwyg, source)).toEqual(Object.keys(EDITOR_SPECIFIC.wysiwygOnly).sort());
  });

  it("SourcePopupView has no hook that WysiwygPopupView lacks, beyond the reasoned list", () => {
    expect(only(source, wysiwyg)).toEqual(Object.keys(EDITOR_SPECIFIC.sourceOnly).sort());
  });

  it("shared hooks agree on visibility and abstractness", () => {
    const mismatched = [...wysiwyg.values()]
      .filter((w) => {
        const s = source.get(w.name);
        return s !== undefined && (s.visibility !== w.visibility || s.isAbstract !== w.isAbstract);
      })
      .map((w) => w.name);
    expect(mismatched).toEqual([]);
  });

  it("keeps both halves of every paired hook", () => {
    for (const pair of PAIRED_HOOKS) {
      expect(wysiwyg.has(pair.wysiwyg), `${pair.concern}: WYSIWYG ${pair.wysiwyg}`).toBe(true);
      expect(source.has(pair.source), `${pair.concern}: Source ${pair.source}`).toBe(true);
    }
  });

  it("gives every exception a reason", () => {
    for (const reasons of Object.values(EDITOR_SPECIFIC)) {
      for (const [name, reason] of Object.entries(reasons)) {
        expect(reason.length, name).toBeGreaterThan(40);
      }
    }
  });
});
