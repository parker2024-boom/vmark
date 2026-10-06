// WI-RA8.1 — the navigation guard a preview surface mounts around
// document-controlled markup.

import { describe, it, expect, vi } from "vitest";
import { anchorHref, guardPreviewNavigation } from "./previewNavigation";

function surface(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const click = (init: MouseEventInit = {}) =>
  new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });

describe("anchorHref", () => {
  it.each([
    ['<a href="https://example.com/x">x</a>', "https://example.com/x"],
    ['<a href="">x</a>', ""],
    ["<a>x</a>", null],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a href="B.md"><text>x</text></a></svg>', "B.md"],
    [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="C.md"><text>x</text></a></svg>',
      "C.md",
    ],
  ])("reads %s", (html, expected) => {
    const root = surface(html);
    expect(anchorHref(root.querySelector("a")!)).toBe(expected);
    root.remove();
  });

  it("prefers href over xlink:href, as the browser does", () => {
    const root = surface(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="new.md" xlink:href="old.md"><text>x</text></a></svg>',
    );
    expect(anchorHref(root.querySelector("a")!)).toBe("new.md");
    root.remove();
  });
});

describe("guardPreviewNavigation", () => {
  it("prevents the click and hands the href to the opener", () => {
    const root = surface('<a href=" https://example.com/x ">x</a>');
    const open = vi.fn();
    guardPreviewNavigation(root, { open });
    const event = click();
    root.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/x");
    root.remove();
  });

  it("treats an image-map area as the link it is", () => {
    const root = surface(
      '<img usemap="#m" alt=""><map name="m"><area shape="rect" coords="0,0,9,9" href="https://example.com/area"></map>',
    );
    const open = vi.fn();
    guardPreviewNavigation(root, { open });
    const event = click();
    root.querySelector("area")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/area");
    root.remove();
  });

  it("prevents the click even with no opener", () => {
    const root = surface('<a href="https://example.com/x">x</a>');
    guardPreviewNavigation(root);
    const event = click();
    root.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    root.remove();
  });

  it("opens once for a double click, and never for a modified button", () => {
    const root = surface('<a href="https://example.com/x">x</a>');
    const open = vi.fn();
    guardPreviewNavigation(root, { open });
    const anchor = root.querySelector("a")!;
    anchor.dispatchEvent(click({ detail: 1 }));
    const second = click({ detail: 2 });
    anchor.dispatchEvent(second);
    const middle = click({ button: 1 });
    anchor.dispatchEvent(middle);
    expect(second.defaultPrevented).toBe(true);
    expect(middle.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it("offers a fragment to jumpTo and prevents the click only when it landed", () => {
    const root = surface('<a id="hit" href="#install">a</a><a id="miss" href="#nowhere">b</a>');
    const open = vi.fn();
    const jumpTo = vi.fn((id: string) => id === "install");
    guardPreviewNavigation(root, { open, jumpTo });

    const hit = click();
    root.querySelector("#hit")!.dispatchEvent(hit);
    expect(jumpTo).toHaveBeenCalledWith("install");
    expect(hit.defaultPrevented).toBe(true);

    const miss = click();
    root.querySelector("#miss")!.dispatchEvent(miss);
    expect(miss.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    root.remove();
  });

  it("leaves a click outside any anchor, and an anchor with no href, alone", () => {
    const root = surface("<p>text</p><a>bare</a>");
    guardPreviewNavigation(root, { open: vi.fn() });
    const onText = click();
    root.querySelector("p")!.dispatchEvent(onText);
    const onBare = click();
    root.querySelector("a")!.dispatchEvent(onBare);
    expect(onText.defaultPrevented).toBe(false);
    expect(onBare.defaultPrevented).toBe(false);
    root.remove();
  });

  it("prevents every form submit", () => {
    const root = surface('<form action="https://evil.example/collect"><button>Go</button></form>');
    guardPreviewNavigation(root);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    root.querySelector("form")!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    root.remove();
  });

  it("covers markup that replaces the first render", () => {
    const root = surface("<p>loading</p>");
    const open = vi.fn();
    guardPreviewNavigation(root, { open });
    root.innerHTML = '<a href="https://example.com/later">x</a>';
    const event = click();
    root.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/later");
    root.remove();
  });

  it("stops guarding once released", () => {
    const root = surface('<a href="https://example.com/x">x</a><form></form>');
    const open = vi.fn();
    const release = guardPreviewNavigation(root, { open });
    release();
    const event = click();
    root.querySelector("a")!.dispatchEvent(event);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    root.querySelector("form")!.dispatchEvent(submit);
    expect(event.defaultPrevented).toBe(false);
    expect(submit.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    root.remove();
  });
});
