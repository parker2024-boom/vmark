import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Editor, getSchema } from "@tiptap/core";
import i18n from "@/i18n";

// The real mermaid live renderer runs; only the third-party `mermaid` engine
// is faked (it is heavy and needs layout jsdom lacks).
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg></svg>" })),
  },
}));

import {
  codePreviewExtension,
  EDITING_STATE_CHANGED,
} from "./tiptap";
import { renderMermaid } from "@/plugins/mermaid";

/**
 * Make the renderer THROW — covers the try/catch around setTimeout's awaited
 * render calls in updateLivePreview. The fault is injected at the DOM
 * boundary: the mermaid renderer reads the editor's mono font size from
 * `getComputedStyle(document.documentElement)` on every locked render, outside
 * its own error handling, so a throwing style read propagates as a rejection.
 */
function failStyleReads() {
  const original = window.getComputedStyle.bind(window);
  return vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    if (el === document.documentElement) throw new Error("boom");
    return original(el, pseudo);
  });
}

type DecorationLike = { type?: { attrs?: Record<string, string> } };

function createStateWithCodeBlock(language: string, text: string) {
  const schema = getSchema([StarterKit]);
  const extensionContext = {
    name: codePreviewExtension.name,
    options: codePreviewExtension.options,
    storage: codePreviewExtension.storage,
    editor: {} as Editor,
    type: null,
    parent: undefined,
  };
  const plugins =
    codePreviewExtension.config.addProseMirrorPlugins?.call(extensionContext) ?? [];
  const emptyDoc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(),
  ]);
  const state = EditorState.create({ schema, doc: emptyDoc, plugins });

  const codeBlock = schema.nodes.codeBlock.create(
    { language },
    schema.text(text),
  );
  const nextState = state.apply(
    state.tr.replaceRangeWith(0, state.doc.content.size, codeBlock),
  );

  return { state: nextState, plugins, schema };
}

function makeDispatchView(baseState: EditorState) {
  const mockView = {
    state: baseState,
    dispatch: vi.fn((tr) => {
      mockView.state = mockView.state.apply(tr);
    }),
    focus: vi.fn(),
    composing: false,
    dom: document.createElement("div"),
  };
  return mockView;
}

describe("updateLivePreview error handling", () => {
  beforeAll(async () => {
    // Load and initialize the engine once, so the injected style-read
    // failure lands in the render, not in the (null-returning) init.
    expect(await renderMermaid("graph TD; A-->B")).toBe("<svg></svg>");
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders error placeholder and does not emit unhandled rejection when renderer throws", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      const { useBlockMathEditingStore } = await import(
        "@/stores/blockMathEditingStore"
      );
      const { state } = createStateWithCodeBlock("mermaid", "graph TD; A-->B");

      let codeBlockPos = -1;
      state.doc.descendants((node, pos) => {
        if (node.type.name === "codeBlock" || node.type.name === "code_block") {
          codeBlockPos = pos;
          return false;
        }
        return true;
      });

      useBlockMathEditingStore
        .getState()
        .startEditing(codeBlockPos, "graph TD; A-->B");

      const extensionContext = {
        name: codePreviewExtension.name,
        options: codePreviewExtension.options,
        storage: codePreviewExtension.storage,
        editor: {} as Editor,
        type: null,
        parent: undefined,
      };
      const freshPlugins =
        codePreviewExtension.config.addProseMirrorPlugins?.call(
          extensionContext,
        ) ?? [];
      const mockView = makeDispatchView(state);
      const viewResult = freshPlugins[0].spec.view!(mockView as never);

      const tr = state.tr.setMeta(EDITING_STATE_CHANGED, true);
      const editingState = state.apply(tr);
      viewResult.update!(
        Object.assign({}, mockView, { state: editingState }) as never,
        {} as never,
      );
      mockView.state = editingState;

      const pluginState = freshPlugins[0].getState(editingState);
      const decs = pluginState.decorations.find();
      const widgetDecs = decs.filter(
        (d: DecorationLike) => !d.type?.attrs?.class,
      );

      // The live preview widget is the last widget decoration (side=1).
      const livePreviewDec = widgetDecs[widgetDecs.length - 1];
      const previewEl = (livePreviewDec as any).type.toDOM(mockView);
      expect(previewEl).toBeInstanceOf(HTMLElement);

      // Fire the debounced callback; the renderer rejects with "boom".
      const styleSpy = failStyleReads();
      try {
        await vi.runAllTimersAsync();
        await vi.waitFor(() =>
          expect(previewEl.querySelector(".code-block-live-preview-error")?.textContent).toBe(
            i18n.t("editor:preview.renderFailed"),
          ),
        );
      } finally {
        styleSpy.mockRestore();
      }

      useBlockMathEditingStore.getState().exitEditing();
      viewResult.destroy!();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
  });
});
