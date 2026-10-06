// WI-RA9B.9 — the reader's settings panel and persistence, run as code. These
// are the paths that changed when the script came under type-checking: every
// handler now validates what it reads from the DOM and from localStorage.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { click, closeExport, exportedMarkdown, openExport } from "./readerHarness";

const STORAGE_KEY = "vmark-reader-settings";

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
}

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`reader did not render ${selector}`);
  return el;
}

function rootVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

let content: string;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  content ??= exportedMarkdown("# Title\n\n中文 and English text.\n\n## Section\n\nMore.");
});

afterEach(() => {
  closeExport();
});

describe("settings panel", () => {
  it("keeps aria-expanded in step with the panel for every way of toggling it", () => {
    openExport(content);
    const toggle = must<HTMLButtonElement>(".vmark-reader-toggle");
    const panel = must<HTMLElement>(".vmark-reader-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);

    click(toggle);
    expect(panel.classList.contains("open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Close reader settings");

    click(must(".vmark-reader-close"));
    expect(panel.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Open reader settings");

    click(toggle);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("steps a range setting, shows it, applies it and persists it", () => {
    openExport(content);
    const plus = must<HTMLButtonElement>('.vmark-reader-btn[data-action="fontSize"][data-dir="1"]');

    click(plus);

    expect(must('[data-value="fontSize"]').textContent).toBe("19px");
    expect(rootVar("--editor-font-size")).toBe("19px");
    expect(stored().fontSize).toBe(19);
  });

  it("clamps a range setting at its bounds", () => {
    openExport(content);
    const minus = must<HTMLButtonElement>('.vmark-reader-btn[data-action="fontSize"][data-dir="-1"]');

    for (let i = 0; i < 40; i++) click(minus);

    expect(must('[data-value="fontSize"]').textContent).toBe("12px");
    expect(stored().fontSize).toBe(12);
  });

  it("ignores a range button whose action or direction is not one it knows", () => {
    openExport(content);
    const plus = must<HTMLButtonElement>('.vmark-reader-btn[data-action="fontSize"][data-dir="1"]');

    plus.dataset.action = "__proto__";
    click(plus);
    plus.dataset.action = "theme";
    click(plus);
    plus.dataset.action = "fontSize";
    plus.dataset.dir = "sideways";
    click(plus);

    expect(must('[data-value="fontSize"]').textContent).toBe("18px");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("switches theme from a theme circle", () => {
    openExport(content);

    click(must('.vmark-reader-theme-circle[data-theme="night"]'));

    expect(stored().theme).toBe("night");
    expect(document.documentElement.classList.contains("dark-theme")).toBe(true);
    expect(must('.vmark-reader-theme-circle[data-theme="night"]').classList.contains("active")).toBe(true);
    expect(must('.vmark-reader-theme-circle[data-theme="paper"]').classList.contains("active")).toBe(false);
  });

  it("applies a checkbox and a select, and ignores settings they do not own", () => {
    openExport(content);
    const expand = must<HTMLInputElement>('input[data-setting="expandDetails"]');
    const latin = must<HTMLSelectElement>('select[data-setting="latinFont"]');

    expand.checked = true;
    expand.dispatchEvent(new Event("change", { bubbles: true }));
    latin.value = "georgia";
    latin.dispatchEvent(new Event("change", { bubbles: true }));
    expect(stored()).toMatchObject({ expandDetails: true, latinFont: "georgia" });
    expect(rootVar("--font-sans")).toContain("Georgia");

    // A checkbox must not be able to write a non-boolean setting, nor a select a non-font one.
    expand.dataset.setting = "fontSize";
    expand.dispatchEvent(new Event("change", { bubbles: true }));
    latin.dataset.setting = "showToc";
    latin.dispatchEvent(new Event("change", { bubbles: true }));
    expect(stored()).toMatchObject({ fontSize: 18, showToc: false });
  });

  it("resets to the defaults", () => {
    openExport(content);
    click(must('.vmark-reader-btn[data-action="fontSize"][data-dir="1"]'));
    click(must('.vmark-reader-theme-circle[data-theme="mint"]'));

    click(must(".vmark-reader-reset-btn"));

    expect(stored()).toMatchObject({ fontSize: 18, theme: "paper" });
    expect(must('[data-value="fontSize"]').textContent).toBe("18px");
  });
});

describe("persisted settings are untrusted input", () => {
  it("restores well-typed values", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 22, theme: "sepia", showToc: true }));
    openExport(content);

    expect(must('[data-value="fontSize"]').textContent).toBe("22px");
    expect(rootVar("--editor-font-size")).toBe("22px");
    expect(must('.vmark-reader-theme-circle[data-theme="sepia"]').classList.contains("active")).toBe(true);
    expect(must(".vmark-toc-sidebar").classList.contains("visible")).toBe(true);
  });

  it("never lets a stored value become markup in the panel", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontSize: '<img src=x onerror="window.__pwned = 1">',
        lineHeight: "<b>bold</b>",
        contentWidth: { toString: "x" },
        cjkLetterSpacing: null,
      }),
    );
    openExport(content);

    const panel = must<HTMLElement>(".vmark-reader-panel");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("b")).toBeNull();
    // Wrongly-typed values fall back to the defaults.
    expect(must('[data-value="fontSize"]').textContent).toBe("18px");
    expect(must('[data-value="lineHeight"]').textContent).toBe("1.6");
    expect(must('[data-value="contentWidth"]').textContent).toBe("50em");
    expect(must('[data-value="cjkLetterSpacing"]').textContent).toBe("0.05em");
  });

  it.each([
    ["an out-of-range number", { fontSize: 9000 }, "28px"],
    ["a negative number", { fontSize: -3 }, "12px"],
    ["a non-finite number", { fontSize: null }, "18px"],
  ])("clamps %s into the setting's bounds", (_name, saved, shown) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    openExport(content);
    expect(must('[data-value="fontSize"]').textContent).toBe(shown);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"paper"'],
    ["JSON null", "null"],
  ])("falls back to the defaults for %s", (_name, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    openExport(content);
    expect(must('[data-value="fontSize"]').textContent).toBe("18px");
    expect(must('.vmark-reader-theme-circle[data-theme="paper"]').classList.contains("active")).toBe(true);
  });

  it("falls back to the default theme and fonts for names it does not know", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: "constructor", latinFont: "__proto__", cjkFont: "nope" }),
    );
    openExport(content);

    expect(document.documentElement.classList.contains("dark-theme")).toBe(false);
    expect(rootVar("--bg-color")).toBe("#EEEDED");
    expect(rootVar("--font-sans")).toContain("system-ui");
    expect(rootVar("--font-sans")).toContain("PingFang SC");
  });
});

describe("keyboard", () => {
  it("adjusts the font size with + and -, but not while typing in a field", () => {
    openExport(content);
    const press = (key: string, target: EventTarget = document.body) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    press("+");
    press("=");
    expect(must('[data-value="fontSize"]').textContent).toBe("20px");
    press("-");
    expect(must('[data-value="fontSize"]').textContent).toBe("19px");

    const field = document.createElement("input");
    document.body.appendChild(field);
    press("+", field);
    expect(must('[data-value="fontSize"]').textContent).toBe("19px");
  });

  it("toggles the table of contents with T", () => {
    openExport(content);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(must(".vmark-toc-sidebar").classList.contains("visible")).toBe(true);
    expect(document.querySelectorAll(".vmark-toc-item")).toHaveLength(2);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "T", bubbles: true }));
    expect(must(".vmark-toc-sidebar").classList.contains("visible")).toBe(false);
  });
});

describe("CJK text treatment", () => {
  it("wraps CJK runs for letter spacing and adds thin spaces at CJK-Latin boundaries, reversibly", () => {
    const editor = openExport(content);
    const paragraph = editor.querySelector("p") as HTMLElement;

    expect(paragraph.querySelector(".cjk-letter-spacing")?.textContent).toBe("中文");
    expect(paragraph.textContent).toBe("中文 and English text.");

    const spacing = must<HTMLInputElement>('input[data-setting="cjkLatinSpacing"]');
    expect(spacing.checked).toBe(true);
    spacing.checked = false;
    spacing.dispatchEvent(new Event("change", { bubbles: true }));
    expect(paragraph.textContent).toBe("中文 and English text.");
    expect(stored().cjkLatinSpacing).toBe(false);
  });

  it("inserts a thin space between adjacent CJK and Latin characters and removes it again", () => {
    const editor = openExport(exportedMarkdown("中文English混排"));
    const paragraph = editor.querySelector("p") as HTMLElement;
    expect(paragraph.textContent).toBe("中文 English 混排");

    const spacing = must<HTMLInputElement>('input[data-setting="cjkLatinSpacing"]');
    spacing.checked = false;
    spacing.dispatchEvent(new Event("change", { bubbles: true }));
    expect(paragraph.textContent).toBe("中文English混排");
  });
});
