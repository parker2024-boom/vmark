// WI-RA24.2 — Source-mode find: the counter keeps its place by POSITION after an
// ordinary edit (the rule WYSIWYG search applies, plugins/search/matchSelection.ts),
// and it counts exactly the matches CodeMirror highlights.
// REAL: the production SourceEditor and its CodeMirror view, the search hook,
// the uiStore search slice, and the tab/document stores behind the real open
// flow. FAKED: `@tauri-apps/*` only (the stateful in-memory disk).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});

import { WindowContext } from "@/contexts/WindowContext";
import { SourceEditor } from "@/components/Editor/SourceEditor";
import { useUIStore } from "@/stores/uiStore";
import { bootstrapFormats } from "@/lib/formats/registryBootstrap";
import { bindPluginHostSettings } from "@/services/assembly/bindHostSettings";
import { ROOT, WINDOW, openDocInTab, resetTier0 } from "@/test/tier0/harness";

/** Let every pending frame and debounce run. */
const settle = (ms = 400): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** jsdom has no layout and does not define these on Range; CodeMirror only needs them to exist. */
const LAYOUT_STUBS: Array<[object, string, () => unknown]> = [
  [Range.prototype, "getClientRects", () => []],
  [Range.prototype, "getBoundingClientRect", () => new DOMRect()],
];

async function mount(content: string): Promise<EditorView> {
  await openDocInTab(`${ROOT}/notes.md`, content);
  render(
    <WindowContext.Provider value={{ windowLabel: WINDOW, isDocumentWindow: true }}>
      <div className="editor-content">
        <SourceEditor />
      </div>
    </WindowContext.Provider>,
  );
  await settle();
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("SourceEditor mounted no CodeMirror view");
  return view;
}

type Options = Partial<{ caseSensitive: boolean; wholeWord: boolean; useRegex: boolean }>;

async function find(query: string, options: Options = {}): Promise<void> {
  const search = useUIStore.getState();
  act(() => {
    search.searchOpen();
    if (options.caseSensitive) search.searchToggleCaseSensitive();
    if (options.wholeWord) search.searchToggleWholeWord();
    if (options.useRegex) search.searchToggleRegex();
    search.searchSetQuery(query);
  });
  await settle();
}

async function next(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) act(() => useUIStore.getState().searchFindNext());
  await settle();
}

/** The counter as the find bar shows it: 1-based current, and the total. */
function counter(): [number, number] {
  const { currentIndex, matchCount } = useUIStore.getState().search;
  return [currentIndex + 1, matchCount];
}

/**
 * The matches CodeMirror's own search engine steps through: press Next once
 * per counted match and record each range it selects, then one more to wrap.
 * Source mode shows the CURRENT match as the selection (there is no
 * all-matches highlight), so this cycle is what the counter must describe.
 */
async function cycle(view: EditorView): Promise<{ ranges: string[]; wrapped: boolean }> {
  const selected = () => `${view.state.selection.main.from}-${view.state.selection.main.to}`;
  const ranges: string[] = [];
  const [, total] = counter();
  for (let i = 0; i < total; i++) {
    ranges.push(selected());
    await next();
  }
  return { ranges, wrapped: total === 0 || selected() === ranges[0] };
}

/** An ordinary edit: typed into the document, nowhere near the find bar. */
async function edit(view: EditorView, from: number, to: number, insert: string): Promise<void> {
  act(() => view.dispatch({ changes: { from, to, insert }, userEvent: "input.type" }));
  await settle();
}

beforeAll(() => {
  bootstrapFormats();
  bindPluginHostSettings();
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  resetTier0();
  useUIStore.setState(useUIStore.getInitialState(), true);
  for (const [target, name, value] of LAYOUT_STUBS) {
    if (name in target) throw new Error(`jsdom now defines ${name}; drop this stub`);
    Object.defineProperty(target, name, { configurable: true, value });
  }
});

afterEach(() => {
  cleanup();
  for (const [target, name] of LAYOUT_STUBS) Reflect.deleteProperty(target, name);
  vi.useRealTimers();
});

describe("the Source-mode counter keeps its place after an ordinary edit", () => {
  const DOC = "cat one\ncat two\ncat three\n";

  it("follows the current match when a new match is typed ABOVE it", async () => {
    const view = await mount(DOC);
    await find("cat");
    await next(); // on "cat two"
    expect(counter()).toEqual([2, 3]);

    await edit(view, 0, 0, "cat ");

    expect(counter()).toEqual([3, 4]); // still "cat two", now the third match
  });

  it("keeps its number when the edit is BELOW the current match", async () => {
    const view = await mount(DOC);
    await find("cat");
    await next();

    await edit(view, view.state.doc.length, view.state.doc.length, "cat four\n");

    expect(counter()).toEqual([2, 4]);
  });

  it("moves to the next match when the current one is edited away", async () => {
    const view = await mount(DOC);
    await find("cat");
    await next(); // "cat two" at 8..11
    await edit(view, 8, 11, "dog");
    expect(counter()).toEqual([2, 2]); // "cat three" is next
  });

  it("wraps to the first match when nothing is left at or after its place", async () => {
    const view = await mount(DOC);
    await find("cat");
    await next(2); // "cat three"
    await edit(view, 16, 19, "dog");
    expect(counter()).toEqual([1, 2]);
  });

  it("follows its place through several edits inside one debounce window", async () => {
    const view = await mount("猫 一\n猫 二\n猫 三\n");
    await find("猫");
    await next(); // "猫 二"
    act(() => view.dispatch({ changes: { from: 0, insert: "猫" } }));
    act(() => view.dispatch({ changes: { from: 0, insert: "猫" } }));
    await settle();
    expect(counter()).toEqual([4, 5]);
  });
});

describe("the Source-mode counter counts the matches CodeMirror steps through", () => {
  it.each([
    ["a regex anchor matches at every line start", "cat\ncat\na cat\n", "^cat", { useRegex: true }, 2],
    ["a regex end anchor matches at every line end", "a cat\nthe cat\ncats\n", "cat$", { useRegex: true }, 2],
    ["Whole Word applies in regex mode too", "cat concat cat\n", "c.t", { useRegex: true, wholeWord: true }, 2],
    ["a typed \\n in a plain query finds a line break", "cat\ndog\ncat\ndog\n", "cat\\ndog", {}, 2],
    ["case folding covers non-ASCII letters", "Ärger ärger ÄRGER\n", "ärger", {}, 3],
    ["a CJK query", "猫和猫头鹰，还有猫。\n", "猫", {}, 3],
  ] as const)("%s", async (_label, content, query, options, expected) => {
    const view = await mount(content);
    await find(query, options);
    expect(counter()).toEqual([1, expected]);
    const { ranges, wrapped } = await cycle(view);
    expect(new Set(ranges).size).toBe(expected);
    expect(wrapped).toBe(true);
  });

  it("an unfinished regex counts nothing", async () => {
    await mount("cat (cat\n");
    await find("(cat", { useRegex: true });
    expect(counter()).toEqual([0, 0]);
  });

  it("recounts with CodeMirror's engine after an edit, not a second regex", async () => {
    const view = await mount("cat\ndog\n");
    await find("^cat", { useRegex: true });
    expect(counter()).toEqual([1, 1]);
    await edit(view, view.state.doc.length, view.state.doc.length, "cat\n");
    expect(counter()).toEqual([1, 2]);
  });
});
