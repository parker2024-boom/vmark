// WI-RA14C.5 — find and replace, from the find bar's own inputs and buttons to
// the document text: a query typed into the bar is counted, stepped through and
// replaced in the mounted WYSIWYG editor, and the result is read back from the
// document store (and, for a CRLF file, from the bytes Save puts on disk).
// REAL: the production editor (`TiptapEditorInner`, so the real search plugin
// and its debounces), the `FindBar` component, the window's `menu:find-replace`
// listener (`useSearchCommands`), the uiStore search slice, the startup binding
// that points the plugins at it (`bindPluginHostSettings`), the editor flush and
// the save path. FAKED: `@tauri-apps/*` only — the stateful in-memory disk, and
// a window event bus that hands menu events to the listeners the app registered.
// Source mode searches through CodeMirror, a separate backend, and is left to
// the real-app journey (e2e/journeys/45-find-replace.mjs).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;
type WindowListener = (event: { payload: unknown }) => void;
const windowBus = vi.hoisted(() => new Map<string, Set<WindowListener>>());

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: (name: string, handler: WindowListener) => {
      const handlers = windowBus.get(name) ?? new Set<WindowListener>();
      windowBus.set(name, handlers.add(handler));
      return Promise.resolve(() => void handlers.delete(handler));
    },
  }),
}));

import { WindowContext } from "@/contexts/WindowContext";
import { FindBar } from "@/components/FindBar";
import { TiptapEditorInner } from "@/components/Editor/TiptapEditor";
import { useSearchCommands } from "@/hooks/useSearchCommands";
import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import { handleSave } from "@/services/files/fileSave";
import { flushActiveWysiwygNow } from "@/utils/wysiwygFlush";
import { bootstrapFormats } from "@/lib/formats/registryBootstrap";
import { bindPluginHostSettings } from "@/services/assembly/bindHostSettings";
import { statefulFs } from "@/test/statefulFsFake";
import { ROOT, WINDOW, doc, openDocInTab, resetTier0 } from "./harness";

const CJK_LINE = "猫和猫头鹰，还有猫。";
/** "cat" four times ignoring case (once inside a longer word), "猫" three times. */
const ORIGINAL = `# Cat notes\n\nThe cat sat. A Cat ran; concat stays.\n\n${CJK_LINE}\n`;

/** The window as the app composes it for this flow: menu listener, bar, editor. */
function DocumentWindow() {
  useSearchCommands();
  return (
    <WindowContext.Provider value={{ windowLabel: WINDOW, isDocumentWindow: true }}>
      <FindBar />
      <div className="editor-content">
        <TiptapEditorInner />
      </div>
    </WindowContext.Provider>
  );
}

/** Let every pending frame, debounce and deferred parse run. */
const settle = (ms = 400): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** Deliver a native menu event the way Rust does: the target window's label as payload. */
async function menu(id: string, targetWindow: string = WINDOW): Promise<void> {
  act(() => windowBus.get(`menu:${id}`)?.forEach((handler) => handler({ payload: targetWindow })));
  await settle();
}

/** Mount the window and open the find bar from the menu. */
async function openFindBar(): Promise<User> {
  render(<DocumentWindow />);
  await settle();
  await menu("find-replace");
  return userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
}

const findInput = () => screen.getByLabelText("Search text in document");
const replaceInput = () => screen.getByLabelText("Replacement text");
const button = (name: string) => screen.getByRole("button", { name });
const counter = () => document.querySelector(".find-bar-count")?.textContent; // what the bar's counter shows

/** Highlighted matches in the editor, and which one is current (1-based; 0 = none). */
function highlights(): { total: number; current: number } {
  const all = [...document.querySelectorAll(".ProseMirror .search-match")];
  return { total: all.length, current: all.findIndex((el) => el.classList.contains("search-match-active")) + 1 };
}

async function typeQuery(user: User, query: string): Promise<void> {
  await user.clear(findInput());
  await user.type(findInput(), query);
  await settle();
}
async function replaceAllWith(user: User, replacement: string): Promise<void> {
  await user.clear(replaceInput());
  await user.type(replaceInput(), replacement);
  await user.click(button("Replace All"));
  await settle();
}

/** The document text in the store once the editor has flushed. */
function storedText(): string {
  flushActiveWysiwygNow();
  return doc(tabId).content;
}

/** jsdom has no layout and does not define these on Range; scrolling to a match only needs them to exist. */
const LAYOUT_STUBS: Array<[object, string, () => unknown]> = [
  [Range.prototype, "getClientRects", () => []],
  [Range.prototype, "getBoundingClientRect", () => new DOMRect()],
];

let tabId: string;

beforeAll(() => {
  bootstrapFormats(); // production registers the format adapters at boot,
  bindPluginHostSettings(); // and points the plugin seams at the stores
});

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  // Testing Library drains each user-event call with a zero timer and only
  // advances a clock it recognises as Jest's; this hands it Vitest's.
  Object.assign(globalThis, { jest: { advanceTimersByTime: (ms: number) => void vi.advanceTimersByTime(ms) } });
  resetTier0();
  windowBus.clear();
  useUIStore.setState(useUIStore.getInitialState(), true);
  useEditorStore.getState().clearTiptap();
  for (const [target, name, value] of LAYOUT_STUBS) {
    if (name in target) throw new Error(`jsdom now defines ${name}; drop this stub`);
    Object.defineProperty(target, name, { configurable: true, value });
  }
  tabId = await openDocInTab(`${ROOT}/notes.md`, ORIGINAL);
});

afterEach(() => {
  cleanup();
  for (const [target, name] of LAYOUT_STUBS) Reflect.deleteProperty(target, name);
  Reflect.deleteProperty(globalThis, "jest");
  vi.useRealTimers();
});

describe("finding", () => {
  it("counts every match of a typed query and steps through them in document order, wrapping", async () => {
    const user = await openFindBar();
    await typeQuery(user, "cat");
    expect(counter()).toBe("1 of 4");
    expect(highlights()).toEqual({ total: 4, current: 1 });
    await user.keyboard("{Enter}");
    await settle();
    expect(counter()).toBe("2 of 4");
    expect(highlights()).toEqual({ total: 4, current: 2 });
    await user.keyboard("{Shift>}{Enter}{Enter}{/Shift}"); // back past the first match
    await settle();
    expect(counter()).toBe("4 of 4");
    await user.click(button("Next (Enter)"));
    await user.click(button("Next (Enter)"));
    await user.click(button("Previous (Shift+Enter)"));
    await settle();
    expect(counter()).toBe("1 of 4");
    // Looking is not editing.
    expect(storedText()).toBe(ORIGINAL);
    expect(doc(tabId).isDirty).toBe(false);
  });

  it("Match Case and Whole Word each narrow the matches, and Replace All honours both", async () => {
    const user = await openFindBar();
    await typeQuery(user, "cat");
    await user.click(button("Match Case"));
    await settle();
    expect(counter()).toBe("1 of 2"); // "The cat", "concat"
    await user.click(button("Whole Word"));
    await settle();
    expect(counter()).toBe("1 of 1"); // "The cat"
    await user.click(button("Match Case"));
    await settle();
    expect(counter()).toBe("1 of 3"); // every standalone word, either case
    await replaceAllWith(user, "kitten");
    expect(storedText()).toBe(`# kitten notes\n\nThe kitten sat. A kitten ran; concat stays.\n\n${CJK_LINE}\n`);
  });

  it("a pattern is literal until regex mode is on, and an unfinished one finds nothing instead of throwing", async () => {
    const user = await openFindBar();
    await typeQuery(user, "c.t");
    expect(counter()).toBe("No results");
    await user.click(button("Use Regular Expression"));
    await settle();
    expect(counter()).toBe("1 of 4");
    await typeQuery(user, "(cat");
    expect(counter()).toBe("No results");
    expect(highlights().total).toBe(0);
    expect(button("Replace All")).toBeDisabled();
    expect(storedText()).toBe(ORIGINAL);
  });

  it("an empty query shows no count, a query with no match says so, and neither can replace", async () => {
    const user = await openFindBar();
    expect(counter()).toBe("");
    for (const name of ["Previous (Shift+Enter)", "Next (Enter)", "Replace", "Replace All"]) expect(button(name)).toBeDisabled();
    await typeQuery(user, "zebra");
    expect(counter()).toBe("No results");
    await user.type(replaceInput(), "horse{Enter}"); // Enter in the replace field is Replace
    await settle();
    await user.clear(findInput());
    await settle();
    expect(counter()).toBe("");
    // The replace events themselves, fired with no query, write nothing either.
    act(() => {
      useUIStore.getState().searchReplaceCurrent();
      useUIStore.getState().searchReplaceAll();
    });
    await settle();
    expect(storedText()).toBe(ORIGINAL);
    expect(doc(tabId).isDirty).toBe(false);
  });
});

describe("replacing", () => {
  it("Replace changes only the current match, and the document is dirty with exactly that text", async () => {
    const user = await openFindBar();
    await typeQuery(user, "cat");
    await user.click(button("Next (Enter)")); // "The cat"
    await user.type(replaceInput(), "dog{Enter}");
    await settle();
    expect(storedText()).toBe(ORIGINAL.replace("The cat", "The dog"));
    expect(doc(tabId).isDirty).toBe(true);
    expect(counter()).toMatch(/ of 3$/);
  });

  it("Replace All rewrites every match in one step, for a CJK query as for a Latin one", async () => {
    const user = await openFindBar();
    await typeQuery(user, "cat");
    await replaceAllWith(user, "kitten");
    expect(counter()).toBe("No results");
    await typeQuery(user, "猫");
    expect(counter()).toBe("1 of 3");
    await replaceAllWith(user, "小狗");
    expect(storedText()).toBe("# kitten notes\n\nThe kitten sat. A kitten ran; conkitten stays.\n\n小狗和小狗头鹰，还有小狗。\n");
    expect(doc(tabId).isDirty).toBe(true);
  });

  it("a replacement that contains the query is applied once per match and does not feed on itself", async () => {
    const user = await openFindBar();
    await typeQuery(user, "cat");
    await replaceAllWith(user, "catalog");
    await settle(2000);
    expect(storedText()).toBe(`# catalog notes\n\nThe catalog sat. A catalog ran; concatalog stays.\n\n${CJK_LINE}\n`);
    expect(counter()).toBe("1 of 4"); // the four replacements still contain it
  });

  it("Replace All then Save puts the replaced text on disk in the file's own CRLF", async () => {
    const path = `${ROOT}/crlf.md`;
    tabId = await openDocInTab(path, "The cat\r\n\r\nA cat\r\n");
    const user = await openFindBar();
    await typeQuery(user, "cat");
    await replaceAllWith(user, "kitten");
    await act(() => handleSave(WINDOW));
    expect(statefulFs.read(path)).toBe("The kitten\r\n\r\nA kitten\r\n");
    expect(doc(tabId).isDirty).toBe(false);
  });
});

describe("opening and closing the bar", () => {
  it("Escape closes it and clears the highlights; a replace fired while closed changes nothing", async () => {
    const user = await openFindBar();
    await typeQuery(user, "cat");
    expect(highlights().total).toBe(4);
    await user.keyboard("{Escape}");
    await settle();
    expect(document.querySelector(".find-bar")).toBeNull();
    expect(highlights().total).toBe(0);
    act(() => useUIStore.getState().searchReplaceAll());
    await settle();
    expect(storedText()).toBe(ORIGINAL);
    // Reopening from the menu brings the query and its highlights back.
    await menu("find-replace");
    expect(counter()).toBe("1 of 4");
    expect(highlights().total).toBe(4);
  });

  it("a menu event addressed to another window opens nothing here", async () => {
    render(<DocumentWindow />);
    await settle();
    await menu("find-replace", "doc-2");
    expect(document.querySelector(".find-bar")).toBeNull();
    await menu("find-replace");
    expect(document.querySelector(".find-bar")).not.toBeNull();
  });
});
