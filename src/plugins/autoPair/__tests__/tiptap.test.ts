// @vitest-environment node
/**
 * Tests for autoPair tiptap extension — extension creation, plugin structure,
 * injected config, IME composition guard. The plugin's props run the REAL
 * handlers, key handler and IME guard against a real ProseMirror state; only
 * the view is a minimal object (state + dispatch + composing), which is all
 * these code paths read.
 */

import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { markProseMirrorCompositionEnd } from "@/utils/imeGuard";
import { autoPairExtension } from "../tiptap";
import type { AutoPairConfig } from "../handlers";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", group: "block" },
    text: { inline: true },
  },
});

const CONFIG: AutoPairConfig = {
  enabled: true,
  includeCJK: false,
  includeCurlyQuotes: false,
  normalizeRightDoubleQuote: false,
};

type TestView = EditorView & { composing: boolean; dispatched: Transaction[] };

/** A view over a single paragraph with the cursor at `cursorOffset`. */
function makeView(text: string, cursorOffset: number): TestView {
  const para = schema.node("paragraph", null, text ? [schema.text(text)] : []);
  const base = EditorState.create({ doc: schema.node("doc", null, [para]), schema });
  const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1 + cursorOffset)));
  const view = {
    state,
    composing: false,
    dispatched: [] as Transaction[],
    dispatch(tr: Transaction) {
      view.dispatched.push(tr);
      view.state = view.state.apply(tr);
    },
  };
  return view as unknown as TestView;
}

const textOf = (view: TestView) => view.state.doc.textContent;
const cursorOf = (view: TestView) => view.state.selection.from - 1;

type Props = {
  handleTextInput: (view: EditorView, from: number, to: number, text: string) => boolean;
  handleDOMEvents: {
    keydown: (view: EditorView, event: KeyboardEvent) => boolean;
    compositionend: (view: EditorView) => boolean;
  };
};

function pluginsFor(options: { getConfig: () => AutoPairConfig }) {
  return autoPairExtension.config.addProseMirrorPlugins!.call({
    editor: {},
    name: "autoPair",
    options,
    storage: {},
    type: undefined,
    parent: undefined,
  } as never);
}

function propsFor(getConfig: () => AutoPairConfig = () => CONFIG): Props {
  return (pluginsFor({ getConfig })[0] as unknown as { props: Props }).props;
}

function key(k: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  let prevented = false;
  return {
    key: k,
    keyCode: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    ...extra,
  } as unknown as KeyboardEvent;
}

/** Type `text` at the view's cursor through the plugin, as ProseMirror would. */
function typeChar(props: Props, view: TestView, text: string): boolean {
  const pos = view.state.selection.from;
  return props.handleTextInput(view, pos, pos, text);
}

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

describe("autoPairExtension metadata", () => {
  it("has correct name", () => {
    expect(autoPairExtension.name).toBe("autoPair");
  });

  it("is an Extension (not a Node or Mark)", () => {
    expect(autoPairExtension.type).toBe("extension");
  });
});

// ---------------------------------------------------------------------------
// Plugin creation
// ---------------------------------------------------------------------------

describe("autoPairExtension addProseMirrorPlugins", () => {
  it("returns exactly one plugin", () => {
    expect(pluginsFor({ getConfig: () => CONFIG })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Config is injected, and asked per input
// ---------------------------------------------------------------------------

describe("autoPair config is INJECTED, not read from a store", () => {
  it("text input pairs an opening bracket with the injected config", () => {
    const view = makeView("", 0);
    expect(typeChar(propsFor(), view, "(")).toBe(true);
    expect(textOf(view)).toBe("()");
    expect(cursorOf(view)).toBe(1);
  });

  it("re-asks per keystroke — a value captured at construction would freeze the answer", () => {
    let enabled = false;
    const props = propsFor(() => ({ ...CONFIG, enabled }));

    const off = makeView("", 0);
    expect(typeChar(props, off, "(")).toBe(false);
    expect(off.dispatched).toHaveLength(0);

    enabled = true;
    const on = makeView("", 0);
    expect(typeChar(props, on, "(")).toBe(true);
    expect(textOf(on)).toBe("()");
  });

  it("the key handler reads the same live getter (Backspace deletes a pair only when enabled)", () => {
    let enabled = false;
    const props = propsFor(() => ({ ...CONFIG, enabled }));

    const off = makeView("()", 1);
    expect(props.handleDOMEvents.keydown(off, key("Backspace"))).toBe(false);
    expect(textOf(off)).toBe("()");

    enabled = true;
    const on = makeView("()", 1);
    const event = key("Backspace");
    expect(props.handleDOMEvents.keydown(on, event)).toBe(true);
    expect(textOf(on)).toBe("");
    expect(event.defaultPrevented).toBe(true);
  });

  it("falls back to a working default when the host supplies nothing", () => {
    // A standalone consumer with no settings layer must get a live plugin,
    // not a dead one.
    const options = autoPairExtension.config.addOptions!.call({} as never) as {
      getConfig: () => AutoPairConfig;
    };
    expect(options.getConfig().enabled).toBe(true);
    const props = (pluginsFor(options)[0] as unknown as { props: Props }).props;
    const view = makeView("", 0);
    expect(typeChar(props, view, "[")).toBe(true);
    expect(textOf(view)).toBe("[]");
  });
});

// ---------------------------------------------------------------------------
// Plugin props — IME guard behavior
// ---------------------------------------------------------------------------

describe("autoPair IME composition guard", () => {
  it("handleTextInput does nothing while the view is composing", () => {
    const view = makeView("", 0);
    view.composing = true;
    expect(typeChar(propsFor(), view, "(")).toBe(false);
    expect(view.dispatched).toHaveLength(0);
  });

  it("handleTextInput does nothing inside the post-composition grace period", () => {
    const view = makeView("", 0);
    markProseMirrorCompositionEnd(view);
    expect(typeChar(propsFor(), view, "(")).toBe(false);
    expect(view.dispatched).toHaveLength(0);
  });

  it("handleTextInput pairs when not composing", () => {
    const view = makeView("ab", 2);
    expect(typeChar(propsFor(), view, "(")).toBe(true);
    expect(textOf(view)).toBe("ab()");
  });

  it("keydown ignores an IME key event (keyCode 229)", () => {
    const view = makeView("()", 1);
    expect(propsFor().handleDOMEvents.keydown(view, key("Backspace", { keyCode: 229 }))).toBe(false);
    expect(view.dispatched).toHaveLength(0);
  });

  it("keydown ignores an event flagged isComposing", () => {
    const view = makeView("()", 1);
    expect(propsFor().handleDOMEvents.keydown(view, key("Backspace", { isComposing: true }))).toBe(false);
    expect(view.dispatched).toHaveLength(0);
  });

  it("keydown delegates to the key handler when not composing (Tab jumps a closing bracket)", () => {
    const view = makeView("()", 1);
    const event = key("Tab");
    expect(propsFor().handleDOMEvents.keydown(view, event)).toBe(true);
    expect(cursorOf(view)).toBe(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keydown returns false and leaves the doc alone while composing", () => {
    const view = makeView("()", 1);
    view.composing = true;
    expect(propsFor().handleDOMEvents.keydown(view, key(")"))).toBe(false);
    expect(view.dispatched).toHaveLength(0);
    expect(cursorOf(view)).toBe(1);
  });

  it("compositionend opens the grace period for that view", () => {
    const props = propsFor();
    const view = makeView("", 0);
    expect(props.handleDOMEvents.compositionend(view)).toBe(false);
    // The grace window now blocks pairing on this view…
    expect(typeChar(props, view, "(")).toBe(false);
    // …but not on a different view.
    const other = makeView("", 0);
    expect(typeChar(props, other, "(")).toBe(true);
  });
});
