// WI-RA9B.9 — footnote navigation in the exported reader, run as CODE in jsdom
// against what the exporter really emits: Markdown goes through the export
// extensions, the export sanitizer and the standalone template, and the script
// that is executed is the one the template inlined.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, closeExport, exportedContent, exportedMarkdown, openExport } from "./readerHarness";

function references(editor: HTMLElement, label: string): HTMLElement[] {
  return [...editor.querySelectorAll<HTMLElement>('[data-type="footnote_reference"]')].filter(
    (el) => el.getAttribute("data-label") === label,
  );
}

function definition(editor: HTMLElement, label: string): HTMLElement {
  const found = [...editor.querySelectorAll<HTMLElement>('[data-type="footnote_definition"]')].find(
    (el) => el.getAttribute("data-label") === label,
  );
  if (!found) throw new Error(`no exported definition for ${label}`);
  return found;
}

function linkOf(reference: HTMLElement): HTMLAnchorElement {
  const link = reference.querySelector("a");
  if (!link) throw new Error("the exporter emitted a reference without a link");
  return link;
}

function backlinkOf(def: HTMLElement): HTMLAnchorElement {
  const link = def.querySelector<HTMLAnchorElement>("a.footnote-backref");
  if (!link) throw new Error("the reader added no backlink to the definition");
  return link;
}

let scrolledTo: Element[];

beforeEach(() => {
  vi.useFakeTimers();
  scrolledTo = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolledTo.push(this);
  };
});

afterEach(() => {
  vi.useRealTimers();
  closeExport();
});

describe("what the exporter emits", () => {
  it("is the markup the reader's selectors are written against", () => {
    const editor = openExport(exportedMarkdown("Body[^note].\n\n[^note]: The note."));
    const [reference] = references(editor, "note");
    const def = definition(editor, "note");

    expect(reference?.tagName).toBe("SUP");
    expect(linkOf(reference as HTMLElement).getAttribute("href")).toBe("#fndef-note");
    expect(def.tagName).toBe("DL");
    expect(def.id).toBe("fndef-note");
    expect(def.querySelector("dd")?.textContent).toContain("The note.");
    // The sanitizer strips the editing attributes the node renderer adds.
    expect(reference?.hasAttribute("contenteditable")).toBe(false);
  });
});

describe("reference → definition", () => {
  it("follows a NAMED label to its own definition", () => {
    const editor = openExport(exportedMarkdown("Body[^note].\n\n[^note]: The note."));
    const def = definition(editor, "note");

    const prevented = click(linkOf(references(editor, "note")[0] as HTMLElement));

    expect(scrolledTo).toEqual([def]);
    expect(prevented).toBe(true);
    expect(def.classList.contains("vmark-highlight")).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(def.classList.contains("vmark-highlight")).toBe(false);
  });

  it("follows numeric labels by LABEL, not by position in the document", () => {
    // The first reference in reading order is [^2]; a positional lookup lands on definition 1.
    const editor = openExport(
      exportedMarkdown("First[^2] then[^1].\n\n[^1]: One.\n\n[^2]: Two."),
    );

    click(linkOf(references(editor, "2")[0] as HTMLElement));
    expect(scrolledTo).toEqual([definition(editor, "2")]);

    click(linkOf(references(editor, "1")[0] as HTMLElement));
    expect(scrolledTo).toEqual([definition(editor, "2"), definition(editor, "1")]);
  });

  it("sends every repeated reference to the one definition", () => {
    const editor = openExport(exportedMarkdown("Once[^a] and again[^a].\n\n[^a]: Shared."));
    const refs = references(editor, "a");
    expect(refs).toHaveLength(2);

    refs.forEach((ref) => click(linkOf(ref)));

    expect(scrolledTo).toEqual([definition(editor, "a"), definition(editor, "a")]);
  });

  it.each([
    ["CJK", "注"],
    ["a selector-hostile label", "a.b:c"],
    ["a label that looks like a number with padding", "007"],
  ])("handles %s", (_name, label) => {
    const editor = openExport(exportedMarkdown(`Body[^${label}].\n\n[^${label}]: Text.`));

    expect(click(linkOf(references(editor, label)[0] as HTMLElement))).toBe(true);
    expect(scrolledTo).toEqual([definition(editor, label)]);
  });

  it("also answers a click on the reference itself, not only on its link", () => {
    const editor = openExport(exportedMarkdown("Body[^note].\n\n[^note]: The note."));

    click(references(editor, "note")[0] as HTMLElement);

    expect(scrolledTo).toEqual([definition(editor, "note")]);
  });

  it("names the link for assistive technology by its label", () => {
    const editor = openExport(exportedMarkdown("Body[^note].\n\n[^note]: The note."));
    const reference = references(editor, "note")[0] as HTMLElement;

    expect(linkOf(reference).getAttribute("aria-label")).toBe("Go to footnote note");
    // The reference wraps a real link; giving the wrapper a link role nests two.
    expect(reference.hasAttribute("role")).toBe(false);
  });

  it("leaves a reference with no definition to the browser", () => {
    const editor = openExport(
      exportedContent(() => ({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Body" },
              { type: "footnote_reference", attrs: { label: "ghost" } },
            ],
          },
        ],
      })),
    );
    const reference = references(editor, "ghost")[0] as HTMLElement;

    // Nothing to go to: the click is not swallowed, nothing scrolls or highlights.
    expect(click(linkOf(reference))).toBe(false);
    expect(scrolledTo).toEqual([]);
    expect(editor.querySelector(".vmark-highlight")).toBeNull();
    expect(linkOf(reference).hasAttribute("aria-label")).toBe(false);
  });

  it("does not hijack ordinary links in the document", () => {
    const editor = openExport(
      exportedMarkdown("See [the site](https://example.com)[^n].\n\n[^n]: Note."),
    );
    const ordinary = editor.querySelector('a[href="https://example.com"]');
    expect(ordinary).not.toBeNull();

    expect(click(ordinary as Element)).toBe(false);
    expect(scrolledTo).toEqual([]);
  });
});

describe("definition → reference", () => {
  it("adds exactly one backlink per definition, inside its content", () => {
    const editor = openExport(
      exportedMarkdown("First[^2] then[^1] again[^1].\n\n[^1]: One.\n\n[^2]: Two."),
    );

    expect(editor.querySelectorAll("a.footnote-backref")).toHaveLength(2);
    const back = backlinkOf(definition(editor, "1"));
    expect(back.parentElement?.tagName).toBe("DD");
    expect(back.getAttribute("href")).toBe("#fnref-1");
    expect(back.getAttribute("aria-label")).toBe("Back to reference 1");
  });

  it("returns to the first reference when the reader arrived by scrolling", () => {
    const editor = openExport(exportedMarkdown("Once[^a] and again[^a].\n\n[^a]: Shared."));
    const [first] = references(editor, "a");

    expect(click(backlinkOf(definition(editor, "a")))).toBe(true);

    expect(scrolledTo).toEqual([first]);
    expect(first?.classList.contains("vmark-highlight")).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(first?.classList.contains("vmark-highlight")).toBe(false);
  });

  it("returns to the reference the reader actually came from", () => {
    const editor = openExport(exportedMarkdown("Once[^a] and again[^a].\n\n[^a]: Shared."));
    const [, second] = references(editor, "a");
    const def = definition(editor, "a");

    click(linkOf(second as HTMLElement));
    click(backlinkOf(def));

    expect(scrolledTo).toEqual([def, second]);
  });

  it("returns by LABEL for out-of-order numeric labels", () => {
    const editor = openExport(
      exportedMarkdown("First[^2] then[^1].\n\n[^1]: One.\n\n[^2]: Two."),
    );

    click(backlinkOf(definition(editor, "1")));

    expect(scrolledTo).toEqual([references(editor, "1")[0]]);
  });

  it("moves keyboard focus with the jump, in both directions", () => {
    const editor = openExport(exportedMarkdown("Body[^note].\n\n[^note]: The note."));
    const reference = references(editor, "note")[0] as HTMLElement;
    const def = definition(editor, "note");

    click(linkOf(reference));
    expect(document.activeElement).toBe(backlinkOf(def));

    click(backlinkOf(def));
    expect(document.activeElement).toBe(linkOf(reference));
  });
});

describe("motion", () => {
  function scrollOptionsFor(reducedMotion: boolean): ScrollIntoViewOptions | undefined {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    let seen: ScrollIntoViewOptions | undefined;
    Element.prototype.scrollIntoView = function scrollIntoView(arg?: boolean | ScrollIntoViewOptions) {
      if (typeof arg === "object") seen = arg;
    };
    const editor = openExport(exportedMarkdown("Body[^note].\n\n[^note]: The note."));
    click(linkOf(references(editor, "note")[0] as HTMLElement));
    vi.unstubAllGlobals();
    return seen;
  }

  it("scrolls smoothly by default", () => {
    expect(scrollOptionsFor(false)).toEqual({ behavior: "smooth", block: "center" });
  });

  it("jumps without animation when the reader prefers reduced motion", () => {
    expect(scrollOptionsFor(true)).toEqual({ behavior: "auto", block: "center" });
  });
});

describe("documents without footnotes", () => {
  it("initialises without adding anything", () => {
    const editor = openExport(exportedMarkdown("# Title\n\nJust prose."));

    expect(editor.querySelector("a.footnote-backref")).toBeNull();
    expect(click(editor.querySelector("p") as Element)).toBe(false);
  });
});
