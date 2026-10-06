// WI-RA8.2 — an SVG stylesheet is rewritten so every rule can only match
// inside the SVG that carries it.
/**
 * Structural tests over jsdom's CSSOM. What the cascade then does with the
 * output is `svgStyleContainment.webkit.test.ts`'s job.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { scopeStylesheet, SVG_STYLE_SCOPE_ATTR, splitSelectorList } from "./svgStylesheetScope";

const KEY = "k1";
const PREFIX = `:is([${SVG_STYLE_SCOPE_ATTR}="${KEY}"], [${SVG_STYLE_SCOPE_ATTR}="${KEY}"] *)`;

/** Every selector of every style rule in `css`, wherever it is nested. */
function selectorsOf(css: string): string[] {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const out: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        out.push(...splitSelectorList((rule as CSSStyleRule).selectorText));
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  walk(sheet.cssRules);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scopeStylesheet — every selector is confined to the SVG", () => {
  it.each([
    ["the whole page", "body *{visibility:hidden}"],
    ["the root", ":root{background:red}"],
    ["the universal selector", "*{outline:9px solid red}"],
    ["a sibling", "svg ~ *{display:none}"],
    ["an ancestor test", "body:has(svg) p{display:none}"],
    ["a selector list", ".a, body, html *{display:none}"],
    ["an attribute holding a comma and a paren", '[title="a,b)"], body{display:none}'],
  ])("scopes %s", (_label, css) => {
    const selectors = selectorsOf(scopeStylesheet(css, KEY));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith(`${PREFIX}:is(`)).toBe(true);
  });

  it("keeps one scoped selector per original selector, so each keeps its own specificity", () => {
    expect(selectorsOf(scopeStylesheet("#m .node rect, #m .node circle{fill:red}", KEY))).toEqual([
      `${PREFIX}:is(#m .node rect)`,
      `${PREFIX}:is(#m .node circle)`,
    ]);
  });

  it("keeps a pseudo-element outside :is(), where it is valid", () => {
    expect(selectorsOf(scopeStylesheet(".a::before, .b:after, ::selection{color:red}", KEY))).toEqual([
      `${PREFIX}:is(.a)::before`,
      `${PREFIX}:is(.b):after`,
      `${PREFIX}:is(*)::selection`,
    ]);
  });

  it("scopes the rules inside @media", () => {
    const out = scopeStylesheet("@media (prefers-color-scheme: dark){body *{fill:white}}", KEY);
    expect(out).toContain("@media (prefers-color-scheme: dark)");
    expect(selectorsOf(out)).toEqual([`${PREFIX}:is(body *)`]);
  });

  it("is idempotent in effect: a scoped sheet scoped again stays confined", () => {
    const once = scopeStylesheet("body *{fill:red}", KEY);
    for (const selector of selectorsOf(scopeStylesheet(once, KEY))) {
      expect(selector.startsWith(`${PREFIX}:is(`)).toBe(true);
    }
  });
});

describe("scopeStylesheet — rules with a document-wide effect are dropped", () => {
  it.each([
    ["@import", '@import url("https://evil.test/x.css"); a{fill:red}'],
    ["@font-face", '@font-face{font-family:"SF Mono";src:local("Comic Sans MS")} a{fill:red}'],
    ["@property", "@property --accent-bg{syntax:'<color>';inherits:false;initial-value:red} a{fill:red}"],
    ["@page", "@page{margin:0} a{fill:red}"],
    ["@namespace", "@namespace svg url(http://www.w3.org/2000/svg); a{fill:red}"],
    ["@layer", "@layer base{body{display:none}} a{fill:red}"],
    ["@supports", "@supports (display:grid){body{display:none}} a{fill:red}"],
    ["@counter-style", "@counter-style x{system:cyclic;symbols:a} a{fill:red}"],
  ])("drops %s and keeps the ordinary rule beside it", (rule, css) => {
    const out = scopeStylesheet(css, KEY);
    expect(out).not.toContain(rule);
    expect(out).not.toContain("evil.test");
    expect(out).not.toMatch(/display:\s*none/);
    expect(selectorsOf(out)).toEqual([`${PREFIX}:is(a)`]);
  });
});

describe("scopeStylesheet — keyframes live in their own namespace", () => {
  it("renames a keyframes rule and every reference to it", () => {
    const out = scopeStylesheet(
      "@keyframes dash{to{stroke-dashoffset:0}} .e{animation:dash 20s linear infinite} .f{animation-name:dash, other}",
      KEY,
    );
    expect(out).toContain(`@keyframes vmark-${KEY}-dash`);
    expect(out).not.toMatch(/@keyframes dash\b/);
    expect(out).toContain(`vmark-${KEY}-dash 20s linear infinite`);
    expect(out).toMatch(new RegExp(`animation-name: vmark-${KEY}-dash, other`));
  });

  it("leaves a reference to a keyframes rule it did not define alone", () => {
    expect(scopeStylesheet(".e{animation:vm-spin 1s}", KEY)).toContain("animation: vm-spin 1s");
  });

  it("drops a keyframes rule whose name is not a plain identifier", () => {
    expect(scopeStylesheet('@keyframes "a b"{to{opacity:0}} a{fill:red}', KEY)).not.toContain("@keyframes");
  });

  it("filters the declarations inside a keyframe", () => {
    const out = scopeStylesheet("@keyframes k{to{position:fixed;opacity:0;background:url(https://evil.test/a)}}", KEY);
    expect(out).toContain("opacity: 0");
    expect(out).not.toContain("fixed");
    expect(out).not.toContain("evil.test");
  });
});

describe("scopeStylesheet — declarations", () => {
  // Values come back in the engine's canonical spelling (`#eee` as
  // `rgb(238, 238, 238)`, `url(#a)` quoted): the sheet is re-serialized from
  // its parsed form by design, so these match either spelling.
  it("keeps ordinary diagram styling (the Mermaid case)", () => {
    const out = scopeStylesheet(".node rect{fill:#eee;stroke:#333}.edgeLabel{color:#111}", KEY);
    expect(out).toMatch(/fill: (#eee|rgb\(238, 238, 238\))/);
    expect(out).toMatch(/stroke: (#333|rgb\(51, 51, 51\))/);
    expect(out).toMatch(/color: (#111|rgb\(17, 17, 17\))/);
  });

  it("keeps a same-document paint reference", () => {
    expect(scopeStylesheet("path{marker-end:url(#arrowhead)}", KEY)).toMatch(
      /marker-end: url\(("?)#arrowhead\1\)/,
    );
  });

  it("keeps !important", () => {
    expect(scopeStylesheet(".e{stroke-dasharray:9,5!important}", KEY)).toContain("!important");
  });

  it.each([
    ["an external url()", "rect{fill:url(https://evil.test/p.svg)}", "evil.test"],
    ["a protocol-relative url()", "rect{fill:url(//evil.test/p.svg)}", "evil.test"],
    ["an image-set() URL", 'rect{background-image:image-set("https://evil.test/a.png" 1x)}', "evil.test"],
    ["a javascript: url()", "a{background:url(javascript:alert(1))}", "javascript"],
    ["expression()", "a{width:expression(alert(1))}", "expression"],
    ["-moz-binding", "a{-moz-binding:url(x.xml#b)}", "binding"],
    ["position: fixed", "a{position:fixed;top:0}", "fixed"],
    ["position: sticky", "a{position:sticky;top:0}", "sticky"],
    ["a URL in a custom property", "a{--bg:url(https://evil.test/a.png)}", "evil.test"],
  ])("drops %s", (_label, css, marker) => {
    expect(scopeStylesheet(css, KEY)).not.toContain(marker);
  });

  it("drops a value spelled with escapes or comments", () => {
    expect(scopeStylesheet("a{position:f\\69xed}", KEY)).not.toMatch(/position/);
    expect(scopeStylesheet("a{background:u\\72l(https://evil.test/a)}", KEY)).not.toContain("evil");
    expect(scopeStylesheet("a{position:fixed/**/}", KEY)).not.toMatch(/position/);
  });

  it("drops a rule that keeps no declaration", () => {
    expect(scopeStylesheet("a{position:fixed}", KEY)).toBe("");
  });
});

describe("scopeStylesheet — edge input", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "  \n "],
    ["unbalanced braces", "a{fill:red"],
    ["a stray closing brace", "}body{display:none}"],
    ["garbage", "<<>>{{;;}}"],
  ])("stays confined for %s input", (_label, css) => {
    for (const selector of selectorsOf(scopeStylesheet(css, KEY))) {
      expect(selector.startsWith(`${PREFIX}:is(`)).toBe(true);
    }
  });

  it("never emits a `<`, which could close the <style> element once serialized", () => {
    const hostile = '[title="\\3c /style\\3e \\3c img src=x onerror=alert(1)\\3e "]{fill:red}';
    expect(scopeStylesheet(hostile, KEY)).toBe("");
  });

  it("returns nothing for an empty sheet, or one that only imports", () => {
    expect(scopeStylesheet("", KEY)).toBe("");
    expect(scopeStylesheet('@import url("https://evil.test/x.css");', KEY)).toBe("");
    expect(scopeStylesheet("@\\69mport url(https://evil.test/x.css);", KEY)).toBe("");
  });

  it("keeps CJK text in a value", () => {
    expect(scopeStylesheet('.n::after{content:"节点"}', KEY)).toContain('"节点"');
  });

  it("drops everything where the engine cannot parse a stylesheet", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    expect(scopeStylesheet("a{fill:red}", KEY)).toBe("");
  });
});

describe("splitSelectorList", () => {
  it.each([
    ["a, b", ["a", "b"]],
    [":is(a, b), c", [":is(a, b)", "c"]],
    ['[title="x, y"], z', ['[title="x, y"]', "z"]],
    ["[data-a='p,q'], r", ["[data-a='p,q']", "r"]],
    ["a\\,b, c", ["a\\,b", "c"]],
    ["", []],
  ])("splits %j", (input, expected) => {
    expect(splitSelectorList(input)).toEqual(expected);
  });
});
