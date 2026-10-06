/**
 * Test helper: observe where markup is parsed.
 *
 * An element of the page's own document starts loading as the parser creates
 * it — attached or not — so untrusted markup must be parsed in an inert
 * document. jsdom loads nothing, so a unit test cannot see the load; it can
 * see which document the markup was written into, and that is what this
 * records.
 */

/** Markup written through `innerHTML`, `outerHTML` or `insertAdjacentHTML`. */
interface MarkupWrite {
  /** Whether the target element belongs to the page's own document. */
  intoPage: boolean;
  markup: string;
}

/** Run `action` and return every markup write that reached the page's document. */
export function pageMarkupWritesDuring(action: () => void): string[] {
  const writes: MarkupWrite[] = [];
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  const outerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML")!;
  const insertAdjacent = Element.prototype.insertAdjacentHTML;
  const record = (el: Element, markup: string) =>
    writes.push({ intoPage: el.ownerDocument === document, markup });

  Object.defineProperty(Element.prototype, "innerHTML", {
    ...innerHtml,
    set(this: Element, value: string) {
      record(this, value);
      innerHtml.set!.call(this, value);
    },
  });
  Object.defineProperty(Element.prototype, "outerHTML", {
    ...outerHtml,
    set(this: Element, value: string) {
      record(this, value);
      outerHtml.set!.call(this, value);
    },
  });
  Element.prototype.insertAdjacentHTML = function (this: Element, position, markup) {
    record(this, markup);
    insertAdjacent.call(this, position, markup);
  };

  try {
    action();
  } finally {
    Object.defineProperty(Element.prototype, "innerHTML", innerHtml);
    Object.defineProperty(Element.prototype, "outerHTML", outerHtml);
    Element.prototype.insertAdjacentHTML = insertAdjacent;
  }
  return writes.filter((write) => write.intoPage).map((write) => write.markup);
}
