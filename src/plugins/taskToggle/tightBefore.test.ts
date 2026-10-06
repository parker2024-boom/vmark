// WI-RA26.2 — the list item's `tightBefore` spacing attribute is markdown-only.
//
// It records that the source wrote an item of a loose list with no blank line
// before it. An item the USER makes is not from the source: splitting an item
// must give the new item the default, or Enter in a loose list would spread
// the "no blank line" spelling to every item typed after it.
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { taskListItemExtension } from "./tiptap";

function editorWith(tightBefore: boolean) {
  return new Editor({
    extensions: [StarterKit.configure({ listItem: false }), taskListItemExtension],
    content: {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            {
              type: "listItem",
              attrs: { tightBefore },
              content: [{ type: "paragraph", content: [{ type: "text", text: "bc" }] }],
            },
          ],
        },
      ],
    },
  });
}

function itemAttrs(editor: Editor): Array<{ text: string; tightBefore: unknown }> {
  const out: Array<{ text: string; tightBefore: unknown }> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "listItem") out.push({ text: node.textContent, tightBefore: node.attrs.tightBefore });
  });
  return out;
}

describe("listItem tightBefore", () => {
  it("defaults to false", () => {
    const editor = editorWith(false);
    expect(itemAttrs(editor).map((i) => i.tightBefore)).toEqual([false, false]);
    editor.destroy();
  });

  it("is not copied to the item a split creates", () => {
    const editor = editorWith(true);
    // Cursor between "b" and "c" in the second item.
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (node.isText && node.text === "bc") pos = at + 1;
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));

    expect(editor.commands.splitListItem("listItem")).toBe(true);

    expect(itemAttrs(editor)).toEqual([
      { text: "a", tightBefore: false },
      { text: "b", tightBefore: true },
      { text: "c", tightBefore: false },
    ]);
    editor.destroy();
  });

  it("is never rendered to HTML or read from pasted HTML", () => {
    const editor = editorWith(true);
    expect(editor.getHTML()).not.toMatch(/tight/i);
    editor.commands.setContent("<ul><li data-tight-before=\"true\" tightbefore=\"true\"><p>x</p></li></ul>");
    expect(itemAttrs(editor).map((i) => i.tightBefore)).toEqual([false]);
    editor.destroy();
  });
});
