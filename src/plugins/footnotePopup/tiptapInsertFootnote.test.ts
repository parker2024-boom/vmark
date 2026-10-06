/**
 * Footnote insertion — insertFootnoteAndOpenPopup against a real editor.
 *
 * The real footnote nodes and the real renumbering run: the assertions read
 * the document the command leaves behind and the request it sends the host.
 * - Inserting a reference and the definition it needs
 * - Renumbering references and definitions around the insertion
 * - Asking the host to open the popup for the inserted footnote, a frame later
 * - A schema without footnote nodes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { bindHostPopups } from "@/plugins/shared/hostPopups";
import { installFakeAnimationFrames, type FakeAnimationFrames } from "@/test/fakeAnimationFrames";
import { footnoteDefinitionExtension, footnoteReferenceExtension } from "./tiptapNodes";
import { insertFootnoteAndOpenPopup } from "./tiptapInsertFootnote";

const openFootnotePopup = vi.fn();

// Opening the footnote editor is asked of the HOST (ADR-015): the toolbar
// action lives in another plugin, so the host port is the seam.
bindHostPopups({ openFootnotePopup: (request) => openFootnotePopup(request) });

const extensions = [StarterKit, footnoteReferenceExtension, footnoteDefinitionExtension];
const schema = getSchema(extensions);

const ref = (label: string) => schema.nodes.footnote_reference.create({ label });
const para = (...content: Array<string | PMNode>) =>
  schema.nodes.paragraph.create(
    null,
    content.filter((c) => c !== "").map((c) => (typeof c === "string" ? schema.text(c) : c)),
  );
const def = (label: string, text: string) => schema.nodes.footnote_definition.create({ label }, para(text));

let frames: FakeAnimationFrames;
let editor: Editor | null = null;

function editorWith(nodes: PMNode[], withFootnotes = true): Editor {
  const place = document.createElement("div");
  document.body.appendChild(place);
  editor = new Editor({
    element: place,
    extensions: withFootnotes ? extensions : [StarterKit],
    content: schema.nodes.doc.create(null, nodes).toJSON(),
  });
  return editor;
}

/** Position just after the first occurrence of `text` in the document. */
function after(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text) + text.length;
    }
  });
  if (found < 0) throw new Error(`text not found: ${text}`);
  return found;
}

/** Every footnote node in document order, as `ref:label` / `def:label=text`. */
function footnotes(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "footnote_reference") out.push(`ref:${node.attrs.label}`);
    if (node.type.name === "footnote_definition") out.push(`def:${node.attrs.label}=${node.textContent}`);
  });
  return out;
}

function positionOf(doc: PMNode, typeName: string, label: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === typeName && node.attrs.label === label) found = pos;
  });
  return found;
}

beforeEach(() => {
  openFootnotePopup.mockClear();
  frames = installFakeAnimationFrames();
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("insertFootnoteAndOpenPopup", () => {
  it("declines, and leaves the document alone, when the schema has no footnote nodes", () => {
    const e = editorWith([para("plain")], false);
    const before = e.state.doc;

    expect(insertFootnoteAndOpenPopup(e)).toBe(false);

    expect(e.state.doc.eq(before)).toBe(true);
    frames.runFrame();
    expect(openFootnotePopup).not.toHaveBeenCalled();
  });

  it("inserts reference 1 at the cursor and appends its empty definition", () => {
    const e = editorWith([para("hello world")]);
    e.commands.setTextSelection(after(e.state.doc, "hello"));

    expect(insertFootnoteAndOpenPopup(e)).toBe(true);

    expect(footnotes(e.state.doc)).toEqual(["ref:1", "def:1="]);
    const paragraph = e.state.doc.child(0);
    expect(paragraph.child(0).text).toBe("hello");
    expect(paragraph.child(1).type.name).toBe("footnote_reference");
    expect(paragraph.child(2).text).toBe(" world");
  });

  it("inserts at the END of a non-empty selection", () => {
    const e = editorWith([para("hello world")]);
    e.commands.setTextSelection({ from: 1, to: after(e.state.doc, "hello") });

    insertFootnoteAndOpenPopup(e);

    expect(e.state.doc.child(0).child(0).text).toBe("hello");
    expect(e.state.doc.child(0).child(1).type.name).toBe("footnote_reference");
  });

  it("numbers a footnote inserted BEFORE an existing one 1, and shifts the old one to 2 with its text", () => {
    const e = editorWith([para("first second", ref("1")), def("1", "旧脚注 old note")]);
    e.commands.setTextSelection(after(e.state.doc, "first"));

    insertFootnoteAndOpenPopup(e);

    expect(footnotes(e.state.doc)).toEqual(["ref:1", "ref:2", "def:1=", "def:2=旧脚注 old note"]);
  });

  it("numbers a footnote inserted AFTER an existing one 2 and keeps the first untouched", () => {
    const e = editorWith([para("first", ref("1"), " second"), def("1", "note one")]);
    e.commands.setTextSelection(after(e.state.doc, "second"));

    insertFootnoteAndOpenPopup(e);

    expect(footnotes(e.state.doc)).toEqual(["ref:1", "ref:2", "def:1=note one", "def:2="]);
  });

  it("asks the host to open the popup for the inserted footnote, focused, one frame later", () => {
    const e = editorWith([para("first", ref("1"), " second"), def("1", "note one")]);
    e.commands.setTextSelection(after(e.state.doc, "second"));

    insertFootnoteAndOpenPopup(e);
    // The reference's DOM is read after the editor has painted it.
    expect(openFootnotePopup).not.toHaveBeenCalled();
    frames.runFrame();

    expect(openFootnotePopup).toHaveBeenCalledTimes(1);
    const request = openFootnotePopup.mock.calls[0][0];
    expect(request).toMatchObject({
      label: "2",
      content: "",
      autoFocus: true,
      referencePos: positionOf(e.state.doc, "footnote_reference", "2"),
      definitionPos: positionOf(e.state.doc, "footnote_definition", "2"),
    });
    expect(request.anchorRect).toBeDefined();
  });

  it("opens the popup for the NEW footnote when an existing reference sits right beside it", () => {
    const e = editorWith([para("word", ref("1")), def("1", "note one")]);
    // Directly before the existing reference: the new one takes label 1.
    e.commands.setTextSelection(after(e.state.doc, "word"));

    insertFootnoteAndOpenPopup(e);
    frames.runFrame();

    expect(footnotes(e.state.doc)).toEqual(["ref:1", "ref:2", "def:1=", "def:2=note one"]);
    expect(openFootnotePopup.mock.calls[0][0]).toMatchObject({
      label: "1",
      referencePos: positionOf(e.state.doc, "footnote_reference", "1"),
      definitionPos: positionOf(e.state.doc, "footnote_definition", "1"),
    });
  });

  it("still succeeds, without a popup, when the reference is no longer in the DOM at the next frame", () => {
    const e = editorWith([para("hello")]);
    e.commands.setTextSelection(after(e.state.doc, "hello"));

    expect(insertFootnoteAndOpenPopup(e)).toBe(true);
    e.view.dom.querySelector('sup[data-type="footnote_reference"]')?.remove();
    frames.runFrame();

    expect(openFootnotePopup).not.toHaveBeenCalled();
    expect(footnotes(e.state.doc)).toEqual(["ref:1", "def:1="]);
  });

  it("gives each rapid repeat its own number", () => {
    const e = editorWith([para("hello")]);
    e.commands.setTextSelection(after(e.state.doc, "hello"));

    insertFootnoteAndOpenPopup(e);
    insertFootnoteAndOpenPopup(e);
    insertFootnoteAndOpenPopup(e);

    expect(footnotes(e.state.doc)).toEqual(["ref:1", "ref:2", "ref:3", "def:1=", "def:2=", "def:3="]);
  });
});
