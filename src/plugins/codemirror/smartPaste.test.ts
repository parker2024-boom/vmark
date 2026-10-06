/**
 * Tests for Smart Paste Plugin (CodeMirror)
 *
 * Tests the paste event handler logic: markdown link creation from URLs,
 * image paste delegation, and AI markdown cleanup.
 *
 * The plugin uses EditorView.domEventHandlers which registers handlers on
 * CM's contentDOM. We test by creating a live view with the extension and
 * dispatching paste events. Note: CodeMirror's own paste handler also calls
 * preventDefault, so we verify behavior via document state and mock calls
 * rather than defaultPrevented for "not handled" cases.
 *
 * The image-paste step and the URL check run for REAL; an image paste is
 * observed through the host's paste toast, the one seam it reports through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCleanPastedMarkdown = vi.fn((text: string) => text);

vi.mock("@/utils/cleanPastedMarkdown", () => ({
  cleanPastedMarkdown: (...args: unknown[]) => mockCleanPastedMarkdown(...args),
}));

const mockHtmlToMarkdown = vi.fn((_html: string) => "");
const mockIsSubstantialHtml = vi.fn((_html: string) => false);
vi.mock("@/utils/htmlToMarkdown", () => ({
  htmlToMarkdown: (...args: unknown[]) => mockHtmlToMarkdown(...args),
  isSubstantialHtml: (...args: unknown[]) => mockIsSubstantialHtml(...args),
}));

const mockGetCodeFenceInfo = vi.fn((): unknown => null);
vi.mock("@/plugins/sourceContextDetection/codeFenceDetection", () => ({
  getCodeFenceInfo: (...args: unknown[]) => mockGetCodeFenceInfo(...args),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSmartPastePlugin } from "./smartPaste";
import { bindHostPopups } from "@/plugins/shared/hostPopups";

const showImagePasteToast = vi.fn();
bindHostPopups({ showImagePasteToast });

const createdViews: EditorView[] = [];

afterEach(() => {
  createdViews.forEach((v) => v.destroy());
  createdViews.length = 0;
});

function createView(
  content: string,
  anchor: number,
  head?: number
): EditorView {
  const extension = createSmartPastePlugin();
  const state = EditorState.create({
    doc: content,
    selection: { anchor, head: head ?? anchor },
    extensions: [extension],
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const view = new EditorView({ state, parent: container });
  createdViews.push(view);
  return view;
}

/**
 * Create a minimal ClipboardData-like object for jsdom which lacks DataTransfer.
 */
function makeClipboardData(text: string, html?: string): DataTransfer {
  const data: Record<string, string> = { "text/plain": text };
  if (html) data["text/html"] = html;
  return {
    getData: (type: string) => data[type] ?? "",
    setData: (type: string, value: string) => { data[type] = value; },
    types: Object.keys(data),
  } as unknown as DataTransfer;
}

/**
 * Dispatch a paste event on the view's contentDOM.
 */
function dispatchPaste(view: EditorView, text: string): void {
  const clipboardData = makeClipboardData(text);
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  view.contentDOM.dispatchEvent(event);
}

/**
 * Dispatch a paste event with null clipboardData (no text/plain).
 */
function dispatchPasteNoData(view: EditorView): void {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "", types: [] },
  });
  view.contentDOM.dispatchEvent(event);
}

describe("createSmartPastePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanPastedMarkdown.mockImplementation((t: string) => t);
    mockGetCodeFenceInfo.mockReturnValue(null);
  });

  describe("export", () => {
    it("returns a valid extension", () => {
      const extension = createSmartPastePlugin();
      expect(extension).toBeDefined();
    });

    it("extension integrates with EditorView", () => {
      const view = createView("hello", 0);
      expect(view.state.doc.toString()).toBe("hello");
    });
  });

  describe("empty / null paste data", () => {
    it("does not invoke any handler for paste with no text/plain", () => {
      const view = createView("hello", 0);
      dispatchPasteNoData(view);

      // Handler returns early — no downstream calls
      expect(showImagePasteToast).not.toHaveBeenCalled();
      expect(mockCleanPastedMarkdown).not.toHaveBeenCalled();
    });

    it("does not invoke any handler for empty string paste", () => {
      const view = createView("hello", 0);
      dispatchPaste(view, "");

      // getData returns "" which is falsy → handler returns false early
      expect(showImagePasteToast).not.toHaveBeenCalled();
      expect(mockCleanPastedMarkdown).not.toHaveBeenCalled();
    });
  });

  describe("image paste delegation", () => {
    it("offers an image URL paste through the host toast and leaves the doc alone", () => {
      const view = createView("hello ", 6);
      dispatchPaste(view, "https://example.com/image.png");

      expect(showImagePasteToast).toHaveBeenCalledTimes(1);
      expect(showImagePasteToast).toHaveBeenCalledWith(
        expect.objectContaining({ imagePath: "https://example.com/image.png", imageType: "url" }),
      );
      // Doc unchanged — the image step consumed the event pending confirmation
      expect(view.state.doc.toString()).toBe("hello ");
      expect(mockCleanPastedMarkdown).not.toHaveBeenCalled();
    });

    it("continues to cleanup when the text is not an image", () => {
      const view = createView("hello", 0);
      dispatchPaste(view, "plain text");

      expect(showImagePasteToast).not.toHaveBeenCalled();
      // cleanPastedMarkdown should still be called
      expect(mockCleanPastedMarkdown).toHaveBeenCalledWith("plain text");
    });

    it("image paste takes priority over URL link creation", () => {
      const view = createView("hello", 0, 5);
      dispatchPaste(view, "https://example.com/image.png");

      expect(showImagePasteToast).toHaveBeenCalledTimes(1);
      // Doc unchanged — image handler consumed it before link creation
      expect(view.state.doc.toString()).toBe("hello");
    });
  });

  describe("markdown cleanup", () => {
    it("inserts cleaned text when cleanPastedMarkdown modifies it", () => {
      mockCleanPastedMarkdown.mockReturnValue("cleaned text");
      const view = createView("hello", 5, 5);
      dispatchPaste(view, "dirty text");

      expect(mockCleanPastedMarkdown).toHaveBeenCalledWith("dirty text");
      expect(view.state.doc.toString()).toBe("hellocleaned text");
    });

    it("replaces selection when cleaning markdown with selection", () => {
      mockCleanPastedMarkdown.mockReturnValue("clean");
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "dirty");

      expect(view.state.doc.toString()).toBe("clean world");
    });

    it("places cursor after cleaned text insertion", () => {
      mockCleanPastedMarkdown.mockReturnValue("ABC");
      const view = createView("hello", 5, 5);
      dispatchPaste(view, "dirty");

      // Cursor at end: "hello" (5) + "ABC" (3) = 8
      expect(view.state.selection.main.anchor).toBe(8);
    });

    it("does not dispatch custom changes when cleaned text is identical", () => {
      mockCleanPastedMarkdown.mockImplementation((t: string) => t);
      const view = createView("hello", 5, 5);
      dispatchPaste(view, "same text");

      // Not a URL, no selection → falls through to default CM paste: no link
      // wrapping of ours touches the document.
      expect(view.state.doc.toString()).not.toContain("](");
    });

    it("markdown cleanup takes priority over URL link creation", () => {
      mockCleanPastedMarkdown.mockReturnValue("cleaned URL text");
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "https://example.com");

      // Should use cleaned text, not create a link
      expect(view.state.doc.toString()).toBe("cleaned URL text world");
    });
  });

  describe("markdown cleanup — code fence guard", () => {
    // Inside a fenced code block "AI-clipboard artifacts" are real code
    // (e.g. the escaped pipe in `s/foo\|bar/x/`) — the cleanup branch must
    // fall through to default paste instead of rewriting the text.

    it("does not rewrite pasted text when cursor is inside a code fence", () => {
      mockGetCodeFenceInfo.mockReturnValue({ language: "sh" });
      mockCleanPastedMarkdown.mockReturnValue("CLEANED");
      const view = createView("hello", 5, 5);
      dispatchPaste(view, "s/foo\\|bar/x/");

      // Handler must not insert the cleaned text — default paste applies
      expect(view.state.doc.toString()).not.toContain("CLEANED");
      expect(mockGetCodeFenceInfo).toHaveBeenCalled();
    });

    it("still cleans pasted markdown outside a code fence", () => {
      mockGetCodeFenceInfo.mockReturnValue(null);
      mockCleanPastedMarkdown.mockReturnValue("CLEANED");
      const view = createView("hello", 5, 5);
      dispatchPaste(view, "s/foo\\|bar/x/");

      expect(view.state.doc.toString()).toBe("helloCLEANED");
    });
  });

  describe("URL paste over selection (link creation)", () => {
    it("creates markdown link when pasting URL over selected text", () => {
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "https://example.com");

      expect(view.state.doc.toString()).toBe("[hello](https://example.com) world");
    });

    it("does not create link when there is no selection", () => {
      const view = createView("hello world", 5, 5);
      dispatchPaste(view, "https://example.com");

      // No selection → handler returns false; no link is built
      expect(view.state.doc.toString()).not.toContain("](https://example.com)");
    });

    it("does not create link when pasted text is not a URL", () => {
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "not a url");

      // Our handler builds no link (CM default paste may still insert the text)
      expect(view.state.doc.toString()).not.toContain("[hello](");
    });

    it("does not create link when the URL contains a space", () => {
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "https://exa mple.com");

      expect(view.state.doc.toString()).not.toContain("[hello](");
    });

    it("does not wrap if selected text already looks like a markdown link", () => {
      const mdLink = "[text](url)";
      const view = createView(mdLink, 0, mdLink.length);
      dispatchPaste(view, "https://example.com");

      // Already a markdown link → handler returns false
      // Verify the doc was NOT changed to a double-wrapped link
      expect(view.state.doc.toString()).not.toContain("[[text]");
    });

    it("trims whitespace from pasted URL", () => {
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "  https://example.com  ");

      expect(view.state.doc.toString()).toBe("[hello](https://example.com) world");
    });

    it("places cursor after inserted link", () => {
      const view = createView("hello world", 0, 5);
      dispatchPaste(view, "https://example.com");

      const expectedLink = "[hello](https://example.com)";
      expect(view.state.selection.main.anchor).toBe(expectedLink.length);
    });

    it("handles http URL", () => {
      const view = createView("click here", 0, 10);
      dispatchPaste(view, "http://example.com");

      expect(view.state.doc.toString()).toBe("[click here](http://example.com)");
    });

    it("handles URL with path and query string", () => {
      const view = createView("docs", 0, 4);
      dispatchPaste(view, "https://example.com/path?q=1");

      expect(view.state.doc.toString()).toBe("[docs](https://example.com/path?q=1)");
    });

    it("handles URL with fragment identifier", () => {
      const view = createView("heading", 0, 7);
      dispatchPaste(view, "https://example.com/page#section");

      expect(view.state.doc.toString()).toBe("[heading](https://example.com/page#section)");
    });

    it("handles single character selection", () => {
      const view = createView("a", 0, 1);
      dispatchPaste(view, "https://example.com");

      expect(view.state.doc.toString()).toBe("[a](https://example.com)");
    });

    it("handles multiline selected text", () => {
      const view = createView("hello\nworld", 0, 11);
      dispatchPaste(view, "https://example.com");

      expect(view.state.doc.toString()).toBe("[hello\nworld](https://example.com)");
    });

    it("handles CJK selection", () => {
      const view = createView("你好世界", 0, 4);
      dispatchPaste(view, "https://example.com/page");

      expect(view.state.doc.toString()).toBe("[你好世界](https://example.com/page)");
    });

    it("handles mid-document selection", () => {
      const view = createView("before target after", 7, 13);
      dispatchPaste(view, "https://example.com");

      expect(view.state.doc.toString()).toBe("before [target](https://example.com) after");
    });

    it("handles paste over entire document", () => {
      const view = createView("hello", 0, 5);
      dispatchPaste(view, "https://example.com");

      expect(view.state.doc.toString()).toBe("[hello](https://example.com)");
    });
  });

  describe("handler priority chain", () => {
    it("image paste > markdown cleanup > URL link", () => {
      // When image paste handles it, nothing else runs
      const view = createView("hello", 0, 5);
      dispatchPaste(view, "https://example.com/pic.jpg");

      expect(showImagePasteToast).toHaveBeenCalled();
      expect(mockCleanPastedMarkdown).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("hello");
    });

    it("when cleanup modifies text, URL link creation is skipped", () => {
      mockCleanPastedMarkdown.mockReturnValue("modified");
      const view = createView("hello", 0, 5);
      dispatchPaste(view, "https://example.com");

      expect(mockCleanPastedMarkdown).toHaveBeenCalled();
      // Cleaned text replaces selection — no link is built
      expect(view.state.doc.toString()).toBe("modified");
    });

    it("when cleanup returns same text, URL check proceeds", () => {
      mockCleanPastedMarkdown.mockImplementation((t: string) => t);
      const view = createView("hello", 0, 5);
      dispatchPaste(view, "https://example.com");

      expect(mockCleanPastedMarkdown).toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("[hello](https://example.com)");
    });
  });

  describe("HTML paste to markdown (smart mode)", () => {
    function dispatchPasteWithHtml(view: EditorView, text: string, html: string): void {
      const clipboardData = makeClipboardData(text, html);
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
      view.contentDOM.dispatchEvent(event);
    }

    beforeEach(() => {
      mockIsSubstantialHtml.mockReturnValue(true);
    });

    it("converts substantial HTML to markdown", () => {
      mockHtmlToMarkdown.mockReturnValue("**bold text**");

      const view = createView("hello", 5, 5);
      dispatchPasteWithHtml(view, "bold text", "<b>bold text</b>");

      expect(view.state.doc.toString()).toBe("hello**bold text**");
    });

    it("falls through when HTML is not substantial", () => {
      mockIsSubstantialHtml.mockReturnValue(false);

      const view = createView("hello", 5, 5);
      dispatchPasteWithHtml(view, "plain text", "<p>plain text</p>");

      // Should not have converted — falls through to default paste
      expect(mockHtmlToMarkdown).not.toHaveBeenCalled();
    });
  });
});
