/**
 * Runs the exported reader as CODE, against what the exporter really emits.
 *
 * Shared by the reader behaviour suites. The path is the production one end to
 * end: Markdown is parsed into the export extensions' schema, rendered by a
 * live editor view, passed through the export sanitizer, wrapped by the
 * standalone template with the reader script inlined, and that inlined script
 * is what gets executed. A hand-written copy of the exporter's markup is what
 * let the reader drift from the exporter in the first place.
 *
 * @module export/reader/__tests__/readerHarness
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor, type JSONContent } from "@tiptap/core";
import { parseMarkdown } from "@/utils/markdownPipeline";
import { createExportExtensions } from "../../createExportExtensions";
import { sanitizeExportHtml } from "../../htmlSanitizer";
import { generateStandaloneHtml } from "../../htmlTemplates";

/** Absolute path of the reader script. */
const READER_PATH = resolve(process.cwd(), "src/export/reader/vmark-reader.js");

const readerSource = readFileSync(READER_PATH, "utf8");

/** The export surface's HTML for a document: the real nodes, then the real sanitizer. */
export function exportedContent(doc: (editor: Editor) => JSONContent): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    extensions: createExportExtensions(),
    editable: false,
    editorProps: { attributes: { class: "export-surface-editor tiptap-editor" } },
  });
  try {
    editor.commands.setContent(doc(editor));
    const surface = host.querySelector(".ProseMirror");
    if (!surface) throw new Error("export surface did not mount");
    return sanitizeExportHtml(surface.innerHTML);
  } finally {
    editor.destroy();
    host.remove();
  }
}

/** The export surface's HTML for a Markdown document. */
export function exportedMarkdown(markdown: string): string {
  return exportedContent((editor) => parseMarkdown(editor.schema, markdown).toJSON() as JSONContent);
}

type Listener = [target: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null];

/** Listeners the running reader put on `document` and `window`, so they can be taken off again. */
const readerListeners: Listener[] = [];
let stopTracking: (() => void) | null = null;

/**
 * A real export is one page with one reader. Here every test runs another
 * reader in the same jsdom window, and each leaves its keydown and scroll
 * listeners on `document`/`window` — where they would answer the NEXT test's
 * key presses with their own stale state.
 */
function trackGlobalListeners(): void {
  if (stopTracking) return;
  const restore = [document, window].map((target: EventTarget) => {
    const original = target.addEventListener;
    target.addEventListener = function (
      type: string,
      fn: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      readerListeners.push([target, type, fn]);
      original.call(target, type, fn, options);
    };
    return () => {
      target.addEventListener = original;
    };
  });
  stopTracking = () => restore.forEach((undo) => undo());
}

/**
 * Load a standalone export into the jsdom document and run its inlined reader.
 * Returns the exported content root.
 */
export function openExport(content: string): HTMLElement {
  trackGlobalListeners();
  const page = generateStandaloneHtml(content, {
    title: "Reader",
    themeCSS: "",
    fontCSS: "",
    contentCSS: "",
    readerCSS: "",
    readerJS: readerSource,
    includeKaTeX: false,
  });
  const parsed = new DOMParser().parseFromString(page, "text/html");
  const script = parsed.querySelector("body > script");
  if (!script?.textContent) throw new Error("the standalone template inlined no reader script");
  script.remove();
  document.body.innerHTML = parsed.body.innerHTML;
  // Indirect eval: the reader is a classic script and must run in global scope.
  (0, eval)(script.textContent);
  const editor = document.querySelector<HTMLElement>(".export-surface-editor");
  if (!editor) throw new Error("the standalone template has no export surface");
  return editor;
}

/** Undo what a reader run leaves on the shared jsdom document. */
export function closeExport(): void {
  stopTracking?.();
  stopTracking = null;
  for (const [target, type, fn] of readerListeners.splice(0)) target.removeEventListener(type, fn);
  document.body.innerHTML = "";
  document.body.className = "";
  document.body.removeAttribute("style");
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  localStorage.clear();
}

/** Dispatch a cancelable click; returns whether the default action was prevented. */
export function click(target: Element): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
