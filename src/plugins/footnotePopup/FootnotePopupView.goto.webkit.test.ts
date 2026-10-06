/**
 * The footnote popup's "go to definition" button in a real engine (#1506).
 *
 * The button did nothing on macOS: it started a smooth scroll of the editor's
 * scroll container, then focused the editor, and in WebKit focusing the
 * editor (ProseMirror's focus() writes the DOM selection) cancels a smooth
 * scroll already in flight. The scroller never moved. jsdom has no scroll
 * animation to cancel; this tier does. Measured before the fix: scrollTop
 * stayed 0 with the definition ~2,000px below.
 */
// timer-isolation: intentional real timers — this tier observes WebKit's own smooth-scroll animation across real frames; a fake clock would remove the scroll whose cancellation is under test.
import { describe, it, expect, afterEach } from "vitest";
import { userEvent } from "vitest/browser";
import { Editor } from "@tiptap/core";
import { createTiptapExtensions } from "@/services/assembly/createTiptapExtensions";
import { parseMarkdown } from "@/utils/markdownPipeline/adapter";
import { useFootnotePopupStore } from "@/stores/footnotePopupStore";
import { findFootnoteDefinition, findFootnoteReference } from "./tiptapDomUtils";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Enough frames for a smooth scroll of a few thousand pixels to finish. */
const SMOOTH_SCROLL_BOUND_FRAMES = 90;

/** Where scrollToPosition puts its target: this far below the scroller's top. */
const SCROLL_OFFSET_PX = 100;

let editor: Editor | null = null;
let editorContainer: HTMLElement | null = null;

afterEach(() => {
  useFootnotePopupStore.getState().closePopup();
  editor?.destroy();
  editorContainer?.remove();
  editor = null;
  editorContainer = null;
});

/** The app's layout: .editor-container > .editor-content (the scroller) > editor. */
function mountEditor(markdown: string): { scroller: HTMLElement; editor: Editor } {
  editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";
  editorContainer.style.cssText = "position:relative;height:400px;width:600px";
  const scroller = document.createElement("div");
  scroller.className = "editor-content";
  scroller.style.cssText = "height:400px;overflow:auto";
  const host = document.createElement("div");
  scroller.appendChild(host);
  editorContainer.appendChild(scroller);
  document.body.appendChild(editorContainer);

  editor = new Editor({ element: host, extensions: createTiptapExtensions() });
  const doc = parseMarkdown(editor.schema, markdown);
  editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content));
  editor.commands.setTextSelection(1); // caret at the top, next to the reference
  editor.view.focus();
  return { scroller, editor };
}

describe("footnote popup go-to-definition (real WebKit)", () => {
  it("scrolls the definition into place and puts the caret in it", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of filler text.`).join("\n\n");
    const { scroller, editor: ed } = mountEditor(
      // Filler after the definition too, so the scroller can bring it to the top.
      `Intro with a note[^1].\n\n${filler}\n\n[^1]: The footnote text.\n\n${filler}\n`,
    );
    await nextFrame();
    const { view } = ed;

    const definition = findFootnoteDefinition(view, "1")!;
    const reference = findFootnoteReference(view, "1")!;
    const anchor = view.dom.querySelector('sup[data-type="footnote_reference"]')!.getBoundingClientRect();
    useFootnotePopupStore.getState().openPopup(
      "1", definition.content,
      { top: anchor.top, left: anchor.left, bottom: anchor.bottom, right: anchor.right },
      definition.pos, reference,
    );
    await nextFrame();
    await nextFrame();

    await userEvent.click(editorContainer!.querySelector<HTMLElement>(".footnote-popup-btn-goto")!);
    for (let frame = 0; frame < SMOOTH_SCROLL_BOUND_FRAMES; frame += 1) await nextFrame();

    const offset = view.coordsAtPos(definition.pos).top - scroller.getBoundingClientRect().top;
    expect(scroller.scrollTop, "the scroller moved").toBeGreaterThan(1000);
    expect(Math.abs(offset - SCROLL_OFFSET_PX), `definition ${Math.round(offset)}px below the top`).toBeLessThanOrEqual(2);
    expect(view.state.selection.$from.node(-1).type.name).toBe("footnote_definition");
    expect(useFootnotePopupStore.getState().isOpen).toBe(false);
  });
});
