/**
 * #1472 — deleting near the end of a large WYSIWYG document must not move the
 * viewport when content-visibility returns after the idle window (real engine).
 *
 * The defect only exists with real layout. Every edit strips `.cv-idle`; the
 * re-add 500ms later measures its scroll compensation in a layout where every
 * block not yet found relevant is skipped at its `contain-intrinsic-size`.
 * When the strip also dropped `contain-intrinsic-size: auto`, every block had
 * lost its remembered size, so near the document's end that collapsed layout
 * was too short to hold the compensated scrollTop: the write clamped and the
 * reader's view was left hundreds of pixels away once the real heights
 * returned (measured: up to 405px in WebKit, 448px in Chromium). jsdom has no
 * layout; this tier does.
 *
 * Built from the production pieces TiptapEditor composes — the extension set,
 * editor.css, buildTiptapEditorProps, the mount-time `.cv-idle` decision, and
 * suppressCvIdleDuringEdit wired to onUpdate the same way — and driven with a
 * real Backspace. Premises are read from the engine's computed style, not
 * from the class.
 *
 * Runs as Windows, where #1472 was reported: the editor branches on the
 * platform (`isMacPlatform` reads `navigator.platform`), and whether a
 * platform uses content-visibility at all may itself become a platform
 * decision (#1473) — this regression is about the platforms that do.
 */
import "@/styles/index.css";
import "@/components/Editor/editor.css";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { userEvent } from "vitest/browser";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { createTiptapExtensions } from "@/services/assembly/createTiptapExtensions";
import { parseMarkdown } from "@/utils/markdownPipeline";
import { contentMayResizeInFlight } from "@/utils/settledScroll";
import { isMacPlatform } from "@/utils/platform";
import {
  buildTiptapEditorProps,
  CV_IDLE_CHAR_THRESHOLD,
  suppressCvIdleDuringEdit,
} from "./tiptapEditorHelpers";

/** Resolves in the task after a frame's rendering update: the painted geometry. */
const afterPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(0);
    }),
  );

/**
 * Paint frames until the scroller's geometry has held still for `stable`
 * consecutive frames — content-visibility has finished deciding which blocks
 * are relevant and recording their remembered sizes. Waits on the condition,
 * not on a guess at how long that takes; `maxFrames` is the liveness bound.
 */
async function untilLayoutSettles(scroller: HTMLElement, content: HTMLElement, stable = 10, maxFrames = 600) {
  const probe = () => `${scroller.scrollTop}:${scroller.scrollHeight}:${content.getBoundingClientRect().height}`;
  let last = probe();
  let still = 0;
  for (let frame = 0; still < stable; frame += 1) {
    if (frame >= maxFrames) throw new Error(`layout did not settle within ${maxFrames} frames`);
    await afterPaint();
    const now = probe();
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

/** Deterministic prose well past the content-visibility threshold. */
function largeMarkdown(): string {
  const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".split(" ");
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const sentence = (n: number) => Array.from({ length: n }, () => words[next(words.length)]).join(" ");
  const lines: string[] = [];
  for (let section = 1; lines.join("\n").length < CV_IDLE_CHAR_THRESHOLD * 2.5; section += 1) {
    lines.push(`## Section ${section}`, "", sentence(40 + next(60)), "");
    lines.push(`- item ${sentence(8)}`, `- item ${sentence(12)}`, `- item ${sentence(6)}`, "");
    lines.push(sentence(30 + next(40)), "");
  }
  return lines.join("\n");
}

interface Mounted {
  editor: Editor;
  scroller: HTMLElement;
  /** content-visibility as the engine saw it right after each onUpdate. */
  cvAfterEachUpdate: boolean[];
  cleanup: () => void;
}

/** Mount the editor the way TiptapEditor does for a document this size. */
function mountLargeEditor(markdown: string): Mounted {
  const frame = document.createElement("div");
  frame.style.cssText = "height:700px;width:900px;display:flex;flex-direction:column";
  const scroller = document.createElement("div");
  scroller.className = "editor-content";
  const container = document.createElement("div");
  container.className = markdown.length >= CV_IDLE_CHAR_THRESHOLD ? "tiptap-editor cv-idle" : "tiptap-editor";
  scroller.appendChild(container);
  frame.appendChild(scroller);
  document.body.appendChild(frame);

  const containerRef = { current: container as HTMLDivElement | null };
  const cvIdleTimeoutRef = { current: null as number | null };
  const cvAfterEachUpdate: boolean[] = [];
  const editor = new Editor({
    element: container,
    extensions: createTiptapExtensions(),
    editorProps: buildTiptapEditorProps(markdown.length),
    onUpdate: ({ editor: updated, transaction }) => {
      if (transaction.getMeta("preventUpdate")) return;
      suppressCvIdleDuringEdit(containerRef, updated.state.doc.content.size, cvIdleTimeoutRef);
      cvAfterEachUpdate.push(contentMayResizeInFlight(updated.view.dom));
    },
  });
  const doc = parseMarkdown(editor.schema, markdown);
  editor.view.dispatch(
    editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, doc.content)
      .setMeta("preventUpdate", true)
      .setMeta("addToHistory", false),
  );
  editor.view.focus();
  return {
    editor,
    scroller,
    cvAfterEachUpdate,
    cleanup: () => {
      if (cvIdleTimeoutRef.current !== null) window.clearTimeout(cvIdleTimeoutRef.current);
      editor.destroy();
      frame.remove();
    },
  };
}

describe("content-visibility idle re-add near the end of a large document (real engine)", () => {
  let mounted: Mounted | undefined;
  beforeEach(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Win32" });
  });
  afterEach(() => {
    mounted?.cleanup();
    Reflect.deleteProperty(navigator, "platform");
  });

  // `slack` keeps the view that far above the bottom: more than the delete
  // removes, so the delete itself never has to clamp — only the idle re-add
  // is under test — and little enough that a collapsed layout would.
  it.each([
    { kind: "within one paragraph", spansBlocks: false, slack: 100 },
    { kind: "across a block boundary", spansBlocks: true, slack: 150 },
  ])("keeps the view still after a delete $kind", async ({ spansBlocks, slack }) => {
    expect(isMacPlatform(), "premise: running as Windows").toBe(false);
    mounted = mountLargeEditor(largeMarkdown());
    const { editor, scroller, cvAfterEachUpdate } = mounted;
    const blocksUseCv = () => contentMayResizeInFlight(editor.view.dom);
    expect(blocksUseCv(), "premise: the engine applies content-visibility").toBe(true);

    await untilLayoutSettles(scroller, editor.view.dom);
    for (let pass = 0; pass < 3; pass += 1) {
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - slack;
      for (let frame = 0; frame < 10; frame += 1) await afterPaint();
    }
    await untilLayoutSettles(scroller, editor.view.dom);

    const viewportTop = () => scroller.getBoundingClientRect().top;
    const blocks = Array.from(editor.view.dom.children) as HTMLElement[];
    const topBlock = blocks.find((block) => block.getBoundingClientRect().bottom > viewportTop() + 1);
    const targetIndex = blocks.findIndex(
      (block) => block.tagName === "P" && block.getBoundingClientRect().top - viewportTop() > 250,
    );
    expect(topBlock, "premise: a block at the top of the viewport").toBeDefined();
    expect(targetIndex, "premise: a paragraph in the lower half of the viewport").toBeGreaterThan(0);
    expect(targetIndex, "premise: a block after the paragraph").toBeLessThan(blocks.length - 1);

    // Within one paragraph: 40 characters from its start. Across a block
    // boundary: the paragraph's last 10 characters through the first 10 of
    // the next block — one join, a line or two of height.
    const target = blocks[targetIndex];
    const targetStart = editor.view.posAtDOM(target, 0);
    const targetEnd = targetStart + target.textContent!.length;
    const start = spansBlocks ? targetEnd - 10 : targetStart + 3;
    const end = spansBlocks ? editor.view.posAtDOM(blocks[targetIndex + 1], 0) + 10 : start + 40;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start, end)));
    await untilLayoutSettles(scroller, editor.view.dom);

    const distanceToBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    expect(distanceToBottom, "premise: reading near the end").toBeLessThanOrEqual(slack + 1);
    expect(distanceToBottom, "premise: not at the very bottom").toBeGreaterThanOrEqual(slack - 1);
    const head = editor.view.coordsAtPos(editor.state.selection.head);
    const viewport = scroller.getBoundingClientRect();
    expect(head.top >= viewport.top && head.bottom <= viewport.bottom, "premise: the selection is in view").toBe(true);

    const offset = () => topBlock!.getBoundingClientRect().top - viewportTop();
    await afterPaint();
    const before = offset();
    const sizeBefore = editor.state.doc.content.size;

    await userEvent.keyboard("{Backspace}");
    expect(editor.state.doc.content.size, "premise: the delete happened").toBeLessThan(sizeBefore);
    expect(cvAfterEachUpdate, "premise: the edit suppressed content-visibility").toEqual([false]);

    // Watch every painted frame until content-visibility has been back for
    // ten of them — through the 500ms idle re-add and past it.
    const drift: number[] = [];
    let framesSinceReturn = 0;
    const began = performance.now();
    while (framesSinceReturn < 10 && performance.now() - began < 5000) {
      await afterPaint();
      drift.push(Math.round(offset() - before));
      if (blocksUseCv()) framesSinceReturn += 1;
    }
    expect(framesSinceReturn, "premise: content-visibility came back").toBe(10);
    expect(
      Math.max(...drift.map(Math.abs)),
      `top block drift per painted frame (px): ${[...new Set(drift)].join(", ")}`,
    ).toBeLessThanOrEqual(1);
  });
});
