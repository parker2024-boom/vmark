// WI-RA8.1 — the Source-mode diagram popup renders the document's own SVG; a
// link or a form in it must never navigate the app's webview.
// WI-RA24.1 — a clicked link opens through the host's opener, resolved against
// the document it was written in, as a link in a WYSIWYG preview does.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../mermaid-preview.css", () => ({}));

import { MermaidPreviewView } from "../MermaidPreviewView";
import { bindHostLinks, resetHostLinks } from "@/plugins/shared/hostLinks";
import { bindHostDocument, resetHostDocument } from "@/plugins/shared/hostDocument";

const ANCHOR = { top: 10, left: 10, bottom: 20, right: 20 };

function shown(markup: string) {
  const view = new MermaidPreviewView();
  view.show("<svg/>", ANCHOR, undefined, "svg");
  const surface = document.querySelector<HTMLElement>(".mermaid-preview-content")!;
  surface.innerHTML = markup;
  return { view, surface };
}

const click = () => new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 });

let current: MermaidPreviewView | null = null;
afterEach(() => {
  current?.destroy();
  current = null;
  resetHostLinks();
  resetHostDocument();
});

describe("the Source-mode diagram popup", () => {
  it("prevents a click on a link in the rendered diagram", () => {
    const { view, surface } = shown(
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.example/"><text>x</text></a></svg>',
    );
    current = view;
    const event = click();
    surface.querySelector("text")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents a form submit", () => {
    const { view, surface } = shown('<form action="https://evil.example/collect"></form>');
    current = view;
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    surface.querySelector("form")!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  it("leaves its own controls alone", () => {
    const { view } = shown("<svg/>");
    current = view;
    const zoomIn = document.querySelector<HTMLElement>('.mermaid-preview-zoom-btn[data-action="in"]')!;
    const event = click();
    zoomIn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector(".mermaid-preview-zoom-value")!.textContent).toBe("110%");
  });

  it("still guards a diagram rendered after the popup was hidden and shown again", () => {
    const { view, surface } = shown("<svg/>");
    current = view;
    view.hide();
    view.show("<svg/>", ANCHOR, undefined, "svg");
    surface.innerHTML = '<a href="https://evil.example/">x</a>';
    const event = click();
    surface.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("a link in the Source-mode diagram popup opens through the host", () => {
  const DOC = "/文档/图表.md";

  function bound(activeFilePath: string | null = DOC) {
    const open = vi.fn();
    bindHostLinks({ open });
    bindHostDocument({
      currentWindowLabel: () => "main",
      activeFilePath: (label) => (label === "main" ? activeFilePath : null),
    });
    return open;
  }

  it.each([
    ["an external URL", '<a href="https://example.com/图">x</a>', "https://example.com/图"],
    ["a relative file link", '<a href="../笔记/第二章.md#小节">x</a>', "../笔记/第二章.md#小节"],
    [
      "an SVG legacy xlink:href",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a xlink:href="https://legacy.example/"><text>x</text></a></svg>',
      "https://legacy.example/",
    ],
  ])("hands %s to the opener with the document's path", (_label, markup, href) => {
    const open = bound();
    const { view, surface } = shown(markup);
    current = view;
    const event = click();
    surface.querySelector("a, text")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(open.mock.calls).toEqual([[href, DOC]]);
  });

  it("opens an untitled document's link with no path to resolve against", () => {
    const open = bound(null);
    const { view, surface } = shown('<a href="https://example.com/">x</a>');
    current = view;
    surface.querySelector("a")!.dispatchEvent(click());
    expect(open.mock.calls).toEqual([["https://example.com/", null]]);
  });

  it("opens once per primary single click, never on another button or the second click of a double", () => {
    const open = bound();
    const { view, surface } = shown('<a href="https://example.com/">x</a>');
    current = view;
    const anchor = surface.querySelector("a")!;
    const middle = new MouseEvent("click", { bubbles: true, cancelable: true, button: 1, detail: 1 });
    const second = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 2 });
    anchor.dispatchEvent(middle);
    anchor.dispatchEvent(second);
    expect([middle.defaultPrevented, second.defaultPrevented]).toEqual([true, true]);
    expect(open).not.toHaveBeenCalled();

    anchor.dispatchEvent(click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("never hands a same-document #fragment to the opener", () => {
    const open = bound();
    const { view, surface } = shown('<a href="#intro">x</a>');
    current = view;
    surface.querySelector("a")!.dispatchEvent(click());
    expect(open).not.toHaveBeenCalled();
  });
});
