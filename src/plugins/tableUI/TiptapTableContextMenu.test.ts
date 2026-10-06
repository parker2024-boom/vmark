/**
 * Tests for TiptapTableContextMenu — imperative DOM context menu for tables.
 *
 * Covers:
 *   - Constructor: container creation, event listener setup
 *   - show(): menu building, host mounting, position calculation
 *   - hide(): visibility reset
 *   - handleClickOutside / handleKeydown
 *   - destroy(): listener cleanup
 *   - Fit-to-width toggle visibility based on global setting
 *   - Every menu item, clicked, performs its REAL table action on a real
 *     3×3 table (the view is a plain object over a real EditorState)
 */

import { bindHostSettings } from "@/plugins/shared/hostSettings";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/icons", () => ({
  icons: new Proxy({}, { get: () => "<svg></svg>" }),
}));

vi.mock("@/plugins/shared/popupHostDom", () => ({
  getPopupHostForDom: vi.fn(() => null),
  toHostCoordsForDom: vi.fn((_host: unknown, pos: { top: number; left: number }) => pos),
}));

let mockTableFitToWidth = false;
// The setting arrives through the plugins' host seam now (ADR-015). Bound to
// the SAME mutable flag the removed store mock read, so the cases that flip it
// keep working unchanged.
bindHostSettings({ tableFitToWidth: () => mockTableFitToWidth });

import { getPopupHostForDom, toHostCoordsForDom } from "@/plugins/shared/popupHostDom";
import { isWrapperFitToWidth, setWrapperFitToWidth } from "@/plugins/shared/tableFitToWidth";
import i18n from "@/i18n";
import { Schema, type Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { tableNodes } from "@tiptap/pm/tables";
import { TiptapTableContextMenu } from "./TiptapTableContextMenu";

const tables = tableNodes({
  tableGroup: "block",
  cellContent: "block+",
  cellAttributes: { alignment: { default: null } },
});
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    ...tables,
  },
});

/** 3×3 table, cells "r{row}c{col}"; r2c2 holds two paragraphs (for Format Table). */
function tableDoc(): PmNode {
  const para = (t: string) => schema.nodes.paragraph.create(null, [schema.text(t)]);
  const rows = [0, 1, 2].map((r) =>
    schema.nodes.table_row.create(
      null,
      [0, 1, 2].map((c) =>
        schema.nodes.table_cell.create(null, r === 2 && c === 2 ? [para("r2c2"), para("more")] : [para(`r${r}c${c}`)]),
      ),
    ),
  );
  return schema.nodes.doc.create(null, [schema.nodes.table.create(null, rows), para("after")]);
}

/**
 * The editor view the menu acts on: a plain object over a real EditorState
 * with the caret in the MIDDLE cell (r1c1). `nodeDOM` answers the table's
 * scroll wrapper, which is where per-table fit-to-width lives.
 */
function createMockView(dom: unknown = { isConnected: true, closest: vi.fn(() => null) }) {
  const doc = tableDoc();
  let caret = -1;
  doc.descendants((node, pos) => {
    if (caret < 0 && node.isText && node.text === "r1c1") caret = pos + 1;
  });
  let state = EditorState.create({ doc, schema });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll-wrapper";
  return {
    dom,
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
    focus: vi.fn(),
    nodeDOM: (pos: number) => (pos === 0 ? wrapper : null),
    wrapper,
  };
}

/** Cell texts of the first table, row by row; null when the doc has no table. */
function grid(view: ReturnType<typeof createMockView>): string[][] | null {
  const table = view.state.doc.firstChild;
  if (table?.type.name !== "table") return null;
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
}

function alignments(view: ReturnType<typeof createMockView>): (string | null)[][] {
  const rows: (string | null)[][] = [];
  view.state.doc.firstChild!.forEach((row) => {
    const cells: (string | null)[] = [];
    row.forEach((cell) => cells.push(cell.attrs.alignment as string | null));
    rows.push(cells);
  });
  return rows;
}

function clickItem(menu: TiptapTableContextMenu, labelKey: string): void {
  const container = (menu as unknown as { container: HTMLElement }).container;
  const label = i18n.t(`editor:tableMenu.${labelKey}`);
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.querySelector(".table-context-menu-label")?.textContent === label,
  );
  expect(button, `menu item ${label}`).toBeDefined();
  button!.click();
}

const ORIGINAL = [
  ["r0c0", "r0c1", "r0c2"],
  ["r1c0", "r1c1", "r1c2"],
  ["r2c0", "r2c1", "r2c2more"],
];

describe("TiptapTableContextMenu", () => {
  let menu: TiptapTableContextMenu;
  let view: ReturnType<typeof createMockView>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTableFitToWidth = false;
    view = createMockView();
    menu = new TiptapTableContextMenu(view as never);
  });

  afterEach(() => {
    menu.destroy();
  });

  it("creates a container element on construction", () => {
    // Container exists but is hidden
    expect(menu).toBeDefined();
  });

  it("shows the menu at specified coordinates", () => {
    menu.show(100, 200);
    // After show, the container should be visible (display: flex)
  });

  it("hides the menu", () => {
    menu.show(100, 200);
    menu.hide();
    // After hide, menu is not visible
  });

  it("hides on click outside", () => {
    menu.show(100, 200);
    // Simulate click outside
    const event = new MouseEvent("mousedown", { bubbles: true });
    document.dispatchEvent(event);
    // Menu should be hidden
  });

  it("hides on Escape key and refocuses editor", () => {
    menu.show(100, 200);
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    document.dispatchEvent(event);
    expect((view as { focus: ReturnType<typeof vi.fn> }).focus).toHaveBeenCalled();
  });

  it("does not react to Escape when not visible", () => {
    // Menu not shown - Escape should not call focus
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    document.dispatchEvent(event);
    expect((view as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled();
  });

  it("does not react to non-Escape keys", () => {
    menu.show(100, 200);
    const event = new KeyboardEvent("keydown", { key: "a" });
    document.dispatchEvent(event);
    // Should not hide
  });

  it("builds menu items including fit-to-width when global setting is OFF", () => {
    mockTableFitToWidth = false;
    menu.show(100, 200);
    // Fit to width item should be in the menu
  });

  it("hides fit-to-width item when global setting is ON", () => {
    mockTableFitToWidth = true;
    menu.show(100, 200);
    // Menu built without fit-to-width
  });

  it("updateView updates the editor view reference", () => {
    const newView = createMockView();
    menu.updateView(newView as never);
    // Should use new view for actions
  });

  it("removes event listeners on destroy", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    menu.destroy();
    expect(removeSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("clicking a menu item performs the action on the table and hides", () => {
    menu.show(100, 200);
    clickItem(menu, "insertRowAbove");
    expect(grid(view)).toEqual([ORIGINAL[0], ["", "", ""], ORIGINAL[1], ORIGINAL[2]]);
    const container = (menu as unknown as { container: HTMLElement }).container;
    expect(container.style.display).toBe("none");
  });

  const COL = (rows: string[][], fn: (row: string[]) => string[]) => rows.map(fn);
  it.each([
    ["insertRowBelow", [ORIGINAL[0], ORIGINAL[1], ["", "", ""], ORIGINAL[2]]],
    ["insertColLeft", COL(ORIGINAL, (r) => [r[0], "", r[1], r[2]])],
    ["insertColRight", COL(ORIGINAL, (r) => [r[0], r[1], "", r[2]])],
    ["deleteRow", [ORIGINAL[0], ORIGINAL[2]]],
    ["deleteCol", COL(ORIGINAL, (r) => [r[0], r[2]])],
    ["deleteTable", null],
  ] as const)("%s changes the table structure", (labelKey, expected) => {
    menu.show(100, 200);
    clickItem(menu, labelKey);
    expect(grid(view as ReturnType<typeof createMockView>)).toEqual(expected);
  });

  it.each([
    ["alignColLeft", "left", false],
    ["alignColCenter", "center", false],
    ["alignColRight", "right", false],
    ["alignAllLeft", "left", true],
    ["alignAllCenter", "center", true],
    ["alignAllRight", "right", true],
  ] as const)("%s aligns the caret column or the whole table", (labelKey, alignment, all) => {
    menu.show(100, 200);
    clickItem(menu, labelKey);
    const expected = [0, 1, 2].map(() => [0, 1, 2].map((c) => (all || c === 1 ? alignment : null)));
    expect(alignments(view as ReturnType<typeof createMockView>)).toEqual(expected);
  });

  it("formatTable flattens multi-paragraph cells into one paragraph", () => {
    menu.show(100, 200);
    clickItem(menu, "formatTable");
    const v = view as ReturnType<typeof createMockView>;
    expect(grid(v)![2][2]).toBe("r2c2 more");
    v.state.doc.firstChild!.forEach((row) => row.forEach((cell) => expect(cell.childCount).toBe(1)));
  });

  it("fitToWidth toggles fit-to-width on the table's scroll wrapper", () => {
    mockTableFitToWidth = false;
    menu.show(100, 200);
    clickItem(menu, "fitToWidth");
    expect(isWrapperFitToWidth((view as ReturnType<typeof createMockView>).wrapper)).toBe(true);
  });

  it("does not hide on mousedown inside the menu container", () => {
    menu.show(100, 200);
    const container = (menu as unknown as { container: HTMLElement }).container;
    const event = new MouseEvent("mousedown", { bubbles: true });
    container.dispatchEvent(event);
    // Should still be visible (click inside does not trigger hide)
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: show() with popup host (lines 128-143)
// When getPopupHostForDom returns a real host element (not null/document.body)
// ---------------------------------------------------------------------------

describe("TiptapTableContextMenu — popup host mounting", () => {
  let menu3: TiptapTableContextMenu;
  let view3: ReturnType<typeof createMockView>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTableFitToWidth = false;
    // Restore default mock implementations
    vi.mocked(getPopupHostForDom).mockReturnValue(null);
    vi.mocked(toHostCoordsForDom).mockImplementation((_host: unknown, pos: { top: number; left: number }) => pos);
    view3 = createMockView();
    menu3 = new TiptapTableContextMenu(view3 as never);
  });

  afterEach(() => {
    menu3.destroy();
  });

  it("mounts container with absolute positioning when host is not document.body", () => {
    const hostEl = document.createElement("div");
    vi.mocked(getPopupHostForDom).mockReturnValue(hostEl);

    menu3.show(50, 60);

    const container = (menu3 as unknown as { container: HTMLElement }).container;
    expect(container.parentElement).toBe(hostEl);
    expect(container.style.position).toBe("absolute");
  });

  it("converts coordinates via toHostCoordsForDom when host is not document.body", () => {
    const hostEl = document.createElement("div");
    vi.mocked(getPopupHostForDom).mockReturnValue(hostEl);
    vi.mocked(toHostCoordsForDom).mockReturnValue({ top: 30, left: 20 });

    menu3.show(50, 60);

    expect(toHostCoordsForDom).toHaveBeenCalledWith(hostEl, { top: 60, left: 50 });
    const container = (menu3 as unknown as { container: HTMLElement }).container;
    expect(container.style.left).toBe("20px");
    expect(container.style.top).toBe("30px");
  });

  it("uses fixed positioning when host is document.body (fallback)", () => {
    vi.mocked(getPopupHostForDom).mockReturnValue(null);

    menu3.show(50, 60);

    const container = (menu3 as unknown as { container: HTMLElement }).container;
    expect(container.style.position).toBe("fixed");
    expect(container.style.left).toBe("50px");
    expect(container.style.top).toBe("60px");
  });

  it("does not re-append when already mounted to the same host", () => {
    const hostEl = document.createElement("div");
    vi.mocked(getPopupHostForDom).mockReturnValue(hostEl);

    menu3.show(50, 60);
    const appendSpy = vi.spyOn(hostEl, "appendChild");
    // Show again — same host
    menu3.show(70, 80);
    // appendChild should not be called again since container is already parented to host
    expect(appendSpy).not.toHaveBeenCalled();
  });
});

describe("TiptapTableContextMenu — Escape when editor disconnected", () => {
  it("does not focus editor when dom is not connected", () => {
    const view = createMockView({ isConnected: false, closest: vi.fn(() => null) });
    const menu = new TiptapTableContextMenu(view as never);
    menu.show(10, 10);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect((view as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled();
    menu.destroy();
  });
});

describe("TiptapTableContextMenu — fit-to-width label variants", () => {
  it("shows 'Natural Width' when current table is already fit-to-width", () => {
    mockTableFitToWidth = false;
    const view = createMockView();
    setWrapperFitToWidth(view.wrapper, true);
    const menu = new TiptapTableContextMenu(view as never);
    menu.show(100, 100);
    const container = (menu as unknown as { container: HTMLElement }).container;
    const labels = Array.from(container.querySelectorAll(".table-context-menu-label"))
      .map((el) => el.textContent);
    expect(labels).toContain("Natural Width");
    menu.destroy();
  });

  it("shows 'Fit to Width' when current table is not fit-to-width", () => {
    mockTableFitToWidth = false;
    const view = createMockView();
    const menu = new TiptapTableContextMenu(view as never);
    menu.show(100, 100);
    const container = (menu as unknown as { container: HTMLElement }).container;
    const labels = Array.from(container.querySelectorAll(".table-context-menu-label"))
      .map((el) => el.textContent);
    expect(labels).toContain("Fit to Width");
    menu.destroy();
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: requestAnimationFrame position adjustment (lines 161-177)
// These run inside requestAnimationFrame after show() — use fake RAF.
// ---------------------------------------------------------------------------

describe("TiptapTableContextMenu — rAF position adjustment", () => {
  let menu2: TiptapTableContextMenu;
  let view2: ReturnType<typeof createMockView>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTableFitToWidth = false;
    // Restore default mock implementations after clearAllMocks resets them
    vi.mocked(getPopupHostForDom).mockReturnValue(null);
    vi.mocked(toHostCoordsForDom).mockImplementation((_host: unknown, pos: { top: number; left: number }) => pos);
    view2 = createMockView();
    menu2 = new TiptapTableContextMenu(view2 as never);
  });

  afterEach(() => {
    menu2.destroy();
  });

  it("adjusts left position when container extends beyond viewport right edge (line 166)", () => {
    // Mock getBoundingClientRect to return a rect that overflows right edge
    const container = (menu2 as unknown as { container: HTMLElement }).container;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 100, bottom: 200, left: 750, right: 820,
      width: 70, height: 100,
      x: 750, y: 100, toJSON: () => {},
    } as DOMRect);

    // Mock innerWidth to be 800 (so right=820 > 800-10=790)
    Object.defineProperty(window, "innerWidth", { value: 800, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    menu2.show(750, 100);

    // Run the rAF callback manually
    expect(rafCallback).not.toBeNull();
    (rafCallback as unknown as FrameRequestCallback)(0);

    // The container left should have been adjusted (newLeft = 800 - 70 - 10 = 720)
    // host === document.body in this test (getPopupHostForDom returns null → document.body)
    expect(container.style.left).toBe("720px");
  });

  // WI-RA9B.4 — a window smaller than the menu must not park it off screen.
  it("never positions the menu at a negative coordinate on a tiny window", () => {
    const container = (menu2 as unknown as { container: HTMLElement }).container;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 50, bottom: 250, left: 50, right: 200,
      width: 150, height: 200,
      x: 50, y: 50, toJSON: () => {},
    } as DOMRect);
    Object.defineProperty(window, "innerWidth", { value: 100, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 100, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    menu2.show(50, 50);
    (rafCallback as FrameRequestCallback | null)?.(0);

    expect(container.style.left).toBe("10px");
    expect(container.style.top).toBe("10px");
  });

  it("adjusts top position when container extends beyond viewport bottom edge (line 176)", () => {
    const container = (menu2 as unknown as { container: HTMLElement }).container;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 500, bottom: 640, left: 100, right: 200,
      width: 100, height: 140,
      x: 100, y: 500, toJSON: () => {},
    } as DOMRect);

    // Mock innerHeight to 600 (so bottom=640 > 600-10=590)
    // editorContainer is null (closest returns null)
    Object.defineProperty(window, "innerWidth", { value: 1200, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    menu2.show(100, 500);

    expect(rafCallback).not.toBeNull();
    (rafCallback as unknown as FrameRequestCallback)(0);

    // maxBottom = viewportHeight - 10 = 590, newTop = 590 - 140 = 450
    expect(container.style.top).toBe("450px");
  });

  it("runs rAF callback without adjustments when menu fits in viewport", () => {
    const container = (menu2 as unknown as { container: HTMLElement }).container;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 100, bottom: 200, left: 100, right: 200,
      width: 100, height: 100,
      x: 100, y: 100, toJSON: () => {},
    } as DOMRect);

    Object.defineProperty(window, "innerWidth", { value: 1200, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    menu2.show(100, 100);

    expect(rafCallback).not.toBeNull();
    (rafCallback as unknown as FrameRequestCallback)(0);

    // No adjustment needed — position stays as-is (100, 100)
    expect(container.style.left).toBe("100px");
    expect(container.style.top).toBe("100px");
  });

  it("adjusts left via toHostCoordsForDom when host is not document.body and overflows right", () => {
    const hostEl = document.createElement("div");
    vi.mocked(getPopupHostForDom).mockReturnValue(hostEl);
    vi.mocked(toHostCoordsForDom).mockImplementation((_host, pos) => pos);

    const container = (menu2 as unknown as { container: HTMLElement }).container;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 100, bottom: 200, left: 750, right: 820,
      width: 70, height: 100,
      x: 750, y: 100, toJSON: () => {},
    } as DOMRect);

    Object.defineProperty(window, "innerWidth", { value: 800, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    menu2.show(750, 100);
    expect(rafCallback).not.toBeNull();
    (rafCallback as unknown as FrameRequestCallback)(0);

    // The clamped viewport point is converted to host coordinates as a whole,
    // and only the axis that moved is written.
    expect(toHostCoordsForDom).toHaveBeenCalledWith(hostEl, { top: 100, left: 720 });
    expect(container.style.left).toBe("720px");
    expect(container.style.top).toBe("100px");
  });

  it("adjusts top via toHostCoordsForDom when host is not document.body and overflows bottom", () => {
    const hostEl = document.createElement("div");
    vi.mocked(getPopupHostForDom).mockReturnValue(hostEl);
    vi.mocked(toHostCoordsForDom).mockImplementation((_host, pos) => pos);

    const container = (menu2 as unknown as { container: HTMLElement }).container;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 500, bottom: 640, left: 100, right: 200,
      width: 100, height: 140,
      x: 100, y: 500, toJSON: () => {},
    } as DOMRect);

    Object.defineProperty(window, "innerWidth", { value: 1200, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    menu2.show(100, 500);
    expect(rafCallback).not.toBeNull();
    (rafCallback as unknown as FrameRequestCallback)(0);

    // maxBottom = 590, newTop = 590 - 140 = 450
    expect(toHostCoordsForDom).toHaveBeenCalledWith(hostEl, { top: 450, left: 100 });
    expect(container.style.top).toBe("450px");
    expect(container.style.left).toBe("100px");
  });

  it("uses editorContainer bottom as maxBottom when available", () => {
    const editorContainer = document.createElement("div");
    const mockView = createMockView({
      isConnected: true,
      closest: vi.fn((selector: string) => selector === ".editor-container" ? editorContainer : null),
    });

    const localMenu = new TiptapTableContextMenu(mockView as never);
    const container = (localMenu as unknown as { container: HTMLElement }).container;

    // Editor container rect: bottom at 400
    vi.spyOn(editorContainer, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 400, left: 0, right: 800,
      width: 800, height: 400,
      x: 0, y: 0, toJSON: () => {},
    } as DOMRect);

    // Menu rect overflows editor bottom
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 350, bottom: 500, left: 100, right: 200,
      width: 100, height: 150,
      x: 100, y: 350, toJSON: () => {},
    } as DOMRect);

    Object.defineProperty(window, "innerWidth", { value: 1200, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, writable: true });

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    localMenu.show(100, 350);
    expect(rafCallback).not.toBeNull();
    (rafCallback as unknown as FrameRequestCallback)(0);

    // maxBottom = editorRect.bottom - 16 = 384, newTop = 384 - 150 = 234
    expect(container.style.top).toBe("234px");
    localMenu.destroy();
  });
});
