// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// Vitest's CSS handling turns the `?raw` stylesheet asset into an empty string
// (see pdfHtmlTemplate.test.ts), so the asset itself — the boundary — is
// supplied. The real `getKatexCSS` (font embedding included) runs over it.
vi.mock("katex/dist/katex.min.css?raw", () => ({
  default:
    '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2")}' +
    ".katex{font:normal 1.21em KaTeX_Main,Times New Roman,serif}",
}));

import { generateStandaloneHtml, generateIndexHtml } from "../htmlTemplates";
import { getKatexCSS } from "../pdfHtmlTemplate";

// The real bundled KaTeX stylesheet — the one the standalone file must carry.
const katexCSS = getKatexCSS();

const baseOptions = {
  title: "Test",
  themeCSS: "",
  fontCSS: "",
  contentCSS: "",
  readerCSS: "",
  readerJS: "",
};

describe("generateStandaloneHtml KaTeX inlining", () => {
  it("does not include external CDN link", () => {
    const html = generateStandaloneHtml("<p>math</p>", baseOptions);
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it("inlines KaTeX CSS in a style tag", () => {
    expect(katexCSS).toContain(".katex{");
    expect(katexCSS).toContain("data:font/woff2;base64,");
    const html = generateStandaloneHtml("<p>math</p>", baseOptions);
    expect(html).toContain(katexCSS);
    expect(html).toContain("<style>");
  });

  it("omits KaTeX CSS when includeKaTeX is false", () => {
    const html = generateStandaloneHtml("<p>no math</p>", {
      ...baseOptions,
      includeKaTeX: false,
    });
    expect(html).not.toContain(katexCSS);
    expect(html).not.toContain(".katex");
  });
});

describe("generateIndexHtml KaTeX (external assets variant)", () => {
  it("uses CDN link for KaTeX since assets are external", () => {
    const html = generateIndexHtml("<p>math</p>", baseOptions);
    expect(html).toContain("cdn.jsdelivr.net");
    expect(html).toContain("katex");
  });

  it("omits KaTeX link when includeKaTeX is false", () => {
    const html = generateIndexHtml("<p>no math</p>", {
      ...baseOptions,
      includeKaTeX: false,
    });
    expect(html).not.toContain("katex");
  });
});
