// WI-RA8.5 — clipboard HTML is parsed in an inert document: converting it to
// markdown must never put its markup into the page's own document.
// WI-RA18.5 — the same for the sanitizers' re-parsing passes: the preview
// style filter and the media iframe filter.
/**
 * An element that belongs to the page's document starts loading the moment
 * the parser creates it, attached or not: an `<img src>` fetches (a beacon to
 * whoever wrote the clipboard) and its `onerror` runs. jsdom loads nothing, so
 * what this suite can observe is the cause — which document received the
 * markup. `inertParsing.webkit.test.ts` observes the effect.
 */

import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown";
import { filterStyleAttributes, KATEX_STYLE_PROPS } from "./styleSafety";
import { sanitizeHtmlPreview } from "./sanitize";
import { pageMarkupWritesDuring } from "./__tests__/markupSinks";

describe("htmlToMarkdown parses clipboard HTML away from the page", () => {
  it.each([
    ["an image", '<p>hi <img src="https://beacon.test/pixel.png" alt="x"></p>'],
    ["an image with an error handler", '<img src="x" onerror="window.__pwned = 1">'],
    ["an image inside bold text", '<b>bold <img src="https://beacon.test/b.png"></b>'],
    ["an image inside italic text", '<i>it <img src="https://beacon.test/i.png"></i>'],
    ["media", '<video src="https://beacon.test/v.mp4" poster="https://beacon.test/p.png"></video>'],
    ["a stylesheet link", '<link rel="stylesheet" href="https://beacon.test/s.css"><p>x</p>'],
    ["an inline SVG image", '<svg><image href="https://beacon.test/s.png"/></svg>'],
    ["nested bold and italic", "<b>a <i>b <b>c</b></i></b>"],
    ["Word markup", '<p class="MsoNormal" style="mso-x:1">Word <o:p></o:p></p>'],
    ["CJK text", "<p>你好 <b>世界</b></p>"],
  ])("writes none of %s into the page's document", (_label, html) => {
    expect(pageMarkupWritesDuring(() => htmlToMarkdown(html))).toEqual([]);
  });

  it("still converts what it parsed", () => {
    expect(htmlToMarkdown('<p>hi <b>there</b> <i>you</i> <img src="a.png" alt="pic"></p>')).toBe(
      "hi **there** *you* ![pic](a.png)\n",
    );
  });

  it("converts nested bold and italic exactly as before", () => {
    expect(htmlToMarkdown("<p><b>a <i>b</i></b></p>")).toBe("**a *b***\n");
  });

  it("keeps Word paragraphs and drops Word's markup", () => {
    expect(
      htmlToMarkdown('<p class="MsoNormal" style="mso-x:1">Word text<o:p></o:p></p><p></p>'),
    ).toBe("Word text\n");
  });

  it("handles an empty string and a bare text node", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("just text")).toBe("just text\n");
  });
});

// The same class in the style filter: it re-parses markup to rewrite `style`
// attributes, and must not do that in the page's document either.
describe("filterStyleAttributes parses away from the page", () => {
  const html = '<span style="color: red; position: fixed">x</span><img src="https://beacon.test/k.png">';

  it("writes nothing into the page's document", () => {
    expect(pageMarkupWritesDuring(() => filterStyleAttributes(html, KATEX_STYLE_PROPS))).toEqual([]);
  });

  it("still filters the declarations", () => {
    expect(filterStyleAttributes(html, KATEX_STYLE_PROPS)).toBe(
      '<span style="color: red">x</span><img src="https://beacon.test/k.png">',
    );
  });
});

// And in the sanitizers that re-parse DOMPurify's output: an image or a media
// element the re-parse creates in the page's document loads from there.
describe("sanitizeHtmlPreview's style filter parses away from the page", () => {
  it.each([
    ["an image beside a styled span", '<span style="color: red; position: fixed">x</span><img src="https://beacon.test/p.png">'],
    ["a styled image", '<img src="https://beacon.test/s.png" style="width: 10px">'],
    ["CJK text", '<span style="color: blue">中文</span><img src="https://beacon.test/c.png">'],
  ])("writes none of %s into the page's document", (_label, html) => {
    expect(pageMarkupWritesDuring(() => sanitizeHtmlPreview(html, { allowStyles: true }))).toEqual([]);
  });

  it("still filters the declarations", () => {
    expect(
      sanitizeHtmlPreview('<span style="color: red; position: fixed">x</span>', { allowStyles: true }),
    ).toBe('<span style="color: red">x</span>');
  });
});

