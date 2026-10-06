/**
 * TiptapTableContextMenu Tests
 *
 * Tests for the Tiptap editor table context menu including:
 * - Menu construction and actions
 * - Show/hide lifecycle
 * - Viewport clamping
 * - Click outside handling
 * - Mounting in editor container
 *
 * The menu's actions are the REAL table actions, run against a plain view
 * object over a real EditorState holding a 3×3 table.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { bindHostSettings } from "@/plugins/shared/hostSettings";

// Mock icons
vi.mock("@/utils/icons", () => ({
  icons: {
    rowAbove: "<svg>rowAbove</svg>",
    rowBelow: "<svg>rowBelow</svg>",
    colLeft: "<svg>colLeft</svg>",
    colRight: "<svg>colRight</svg>",
    deleteRow: "<svg>deleteRow</svg>",
    deleteCol: "<svg>deleteCol</svg>",
    deleteTable: "<svg>deleteTable</svg>",
    alignLeft: "<svg>alignLeft</svg>",
    alignCenter: "<svg>alignCenter</svg>",
    alignRight: "<svg>alignRight</svg>",
    alignAllLeft: "<svg>alignAllLeft</svg>",
    alignAllCenter: "<svg>alignAllCenter</svg>",
    alignAllRight: "<svg>alignAllRight</svg>",
    formatTable: "<svg>formatTable</svg>",
    fitToWidth: "<svg>fitToWidth</svg>",
  },
}));

vi.mock("@/plugins/shared/popupHostDom", () => ({
  getPopupHostForDom: (dom: HTMLElement) => dom.closest(".editor-container"),
  toHostCoordsForDom: (_host: HTMLElement, pos: { top: number; left: number }) => pos,
}));

// The setting arrives through the plugins' host seam now (ADR-015).
// Rebound before EVERY case so an override cannot leak into the next.
beforeEach(() => {
  bindHostSettings({ tableFitToWidth: () => false });
});

// Import after mocking
import { TiptapTableContextMenu } from "../TiptapTableContextMenu";
import { isWrapperFitToWidth } from "@/plugins/shared/tableFitToWidth";
import { Schema, type Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { tableNodes } from "@tiptap/pm/tables";

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

/** Cell texts of the leading table, row by row; null when the doc has none. */
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

const ORIGINAL = [
  ["r0c0", "r0c1", "r0c2"],
  ["r1c0", "r1c1", "r1c2"],
  ["r2c0", "r2c1", "r2c2more"],
];

// Helper functions
function createEditorContainer() {
  const container = document.createElement("div");
  container.className = "editor-container";
  container.style.position = "relative";
  container.style.width = "800px";
  container.style.height = "600px";
  container.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    bottom: 600,
    right: 800,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  const editorDom = document.createElement("div");
  editorDom.className = "ProseMirror";
  container.appendChild(editorDom);

  document.body.appendChild(container);

  return {
    container,
    editorDom,
    cleanup: () => container.remove(),
  };
}

/**
 * A plain view object over a real EditorState: caret in the middle cell
 * (r1c1); `nodeDOM` answers the table's scroll wrapper for fit-to-width.
 */
function createMockView(editorDom: HTMLElement) {
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
    dom: editorDom,
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

describe("TiptapTableContextMenu", () => {
  let dom: ReturnType<typeof createEditorContainer>;
  let view: ReturnType<typeof createMockView>;
  let menu: TiptapTableContextMenu;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    dom = createEditorContainer();
    view = createMockView(dom.editorDom);
    menu = new TiptapTableContextMenu(view as unknown as ConstructorParameters<typeof TiptapTableContextMenu>[0]);
  });

  afterEach(() => {
    menu.destroy();
    dom.cleanup();
  });

  describe("Construction", () => {
    it("creates container element on construction", () => {
      // Container not yet visible but created
      const container = document.querySelector(".table-context-menu");
      // Container is created but not in DOM until show()
      expect(container).toBeNull(); // Not mounted until show()
    });

    it("registers click outside listener", () => {
      const addEventListenerSpy = vi.spyOn(document, "addEventListener");
      const newMenu = new TiptapTableContextMenu(view as unknown as ConstructorParameters<typeof TiptapTableContextMenu>[0]);
      expect(addEventListenerSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
      newMenu.destroy();
    });
  });

  describe("Show/Hide lifecycle", () => {
    it("shows menu at specified position", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container).not.toBeNull();
      expect(container.style.display).toBe("flex");
      expect(container.style.left).toBe("100px");
      expect(container.style.top).toBe("200px");
    });

    it("hides menu", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      menu.hide();

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container.style.display).toBe("none");
    });

    it("mounts inside editor-container when available", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = dom.container.querySelector(".table-context-menu");
      expect(container).not.toBeNull();
      expect(dom.container.contains(container)).toBe(true);
    });

    it("uses absolute positioning when in editor container", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container.style.position).toBe("absolute");
    });
  });

  describe("Menu actions", () => {
    beforeEach(async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));
    });

    it("renders all 15 menu items (including Fit to Width)", () => {
      const items = document.querySelectorAll(".table-context-menu-item");
      expect(items.length).toBe(15);
    });

    it("renders dividers between sections", () => {
      const dividers = document.querySelectorAll(".table-context-menu-divider");
      expect(dividers.length).toBeGreaterThan(0);
    });

    // Items in menu order; each click runs the real action on the caret cell (r1c1).
    const click = (index: number) =>
      (document.querySelectorAll(".table-context-menu-item")[index] as HTMLElement).click();
    const COL = (fn: (row: string[]) => string[]) => ORIGINAL.map(fn);

    it.each([
      [0, "Insert Row Above", [ORIGINAL[0], ["", "", ""], ORIGINAL[1], ORIGINAL[2]]],
      [1, "Insert Row Below", [ORIGINAL[0], ORIGINAL[1], ["", "", ""], ORIGINAL[2]]],
      [2, "Insert Column Left", COL((r) => [r[0], "", r[1], r[2]])],
      [3, "Insert Column Right", COL((r) => [r[0], r[1], "", r[2]])],
      [4, "Delete Row", [ORIGINAL[0], ORIGINAL[2]]],
      [5, "Delete Column", COL((r) => [r[0], r[2]])],
      [6, "Delete Table", null],
    ] as const)("item %i (%s) changes the table structure", (index, _name, expected) => {
      click(index);
      expect(grid(view)).toEqual(expected);
    });

    it.each([
      [7, "left", false],
      [8, "center", false],
      [9, "right", false],
      [10, "left", true],
      [11, "center", true],
      [12, "right", true],
    ] as const)("item %i aligns %s (whole table: %s)", (index, alignment, all) => {
      click(index);
      const expected = [0, 1, 2].map(() => [0, 1, 2].map((c) => (all || c === 1 ? alignment : null)));
      expect(alignments(view)).toEqual(expected);
    });

    it("Format Table flattens multi-paragraph cells", () => {
      click(13);
      expect(grid(view)![2][2]).toBe("r2c2 more");
    });

    it("Fit to Width toggles the table's scroll wrapper", () => {
      click(14);
      expect(isWrapperFitToWidth(view.wrapper)).toBe(true);
    });

    it("hides menu after action", () => {
      const items = document.querySelectorAll(".table-context-menu-item");
      (items[0] as HTMLElement).click();

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container.style.display).toBe("none");
    });

    it("marks danger items with correct class", () => {
      const dangerItems = document.querySelectorAll(".table-context-menu-item-danger");
      expect(dangerItems.length).toBe(3); // Delete Row, Delete Column, Delete Table
    });
  });

  describe("Click outside handling", () => {
    it("hides menu when clicking outside", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const outsideEl = document.createElement("div");
      document.body.appendChild(outsideEl);

      const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
      Object.defineProperty(mousedownEvent, "target", { value: outsideEl });
      document.dispatchEvent(mousedownEvent);

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container.style.display).toBe("none");
    });

    it("does not hide when clicking inside menu", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
      Object.defineProperty(mousedownEvent, "target", { value: container });
      document.dispatchEvent(mousedownEvent);

      expect(container.style.display).toBe("flex");
    });

    it("does not respond to clicks when not visible", async () => {
      // Don't show the menu — it starts hidden
      const outsideEl = document.createElement("div");
      document.body.appendChild(outsideEl);

      const mousedownEvent = new MouseEvent("mousedown", { bubbles: true });
      Object.defineProperty(mousedownEvent, "target", { value: outsideEl });
      document.dispatchEvent(mousedownEvent);

      // Menu container may or may not exist; if it does, it should be hidden
      const container = document.querySelector(".table-context-menu") as HTMLElement | null;
      if (container) {
        expect(container.style.display).toBe("none");
      } else {
        // No container means no menu was ever created — correct behavior
        expect(container).toBeNull();
      }
    });
  });

  describe("Escape key handling", () => {
    it("hides menu when Escape is pressed", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container.style.display).toBe("flex");

      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.dispatchEvent(escapeEvent);

      expect(container.style.display).toBe("none");
    });

    it("focuses editor after Escape", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.dispatchEvent(escapeEvent);

      expect(view.focus).toHaveBeenCalled();
    });

    it("does not hide menu on other keys", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = document.querySelector(".table-context-menu") as HTMLElement;

      const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      document.dispatchEvent(enterEvent);

      expect(container.style.display).toBe("flex");
    });
  });

  describe("View update", () => {
    it("updateView updates the editor view reference", async () => {
      const newEditorDom = document.createElement("div");
      const newView = createMockView(newEditorDom);

      menu.updateView(newView as unknown as ConstructorParameters<typeof TiptapTableContextMenu>[0]);
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const items = document.querySelectorAll(".table-context-menu-item");
      (items[0] as HTMLElement).click();

      // The row lands in the NEW view's document; the old one is untouched.
      expect(grid(newView)).toHaveLength(4);
      expect(grid(view)).toEqual(ORIGINAL);
    });
  });

  describe("Cleanup", () => {
    it("removes container on destroy", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      expect(document.querySelector(".table-context-menu")).not.toBeNull();

      menu.destroy();

      expect(document.querySelector(".table-context-menu")).toBeNull();
    });

    it("removes event listener on destroy", () => {
      const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

      menu.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
    });

    it("removes keydown event listener on destroy", () => {
      const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

      menu.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    });
  });

  describe("Global setting: tableFitToWidth", () => {
    it("hides Fit to Width item when global tableFitToWidth is ON", async () => {
    bindHostSettings({ tableFitToWidth: () => true });
      // Re-mock settings to enable global fit
      const { useSettingsStore } = await import("@/stores/settingsStore");
      const originalGetState = useSettingsStore.getState;
      (useSettingsStore as { getState: () => unknown }).getState = () => ({
        markdown: { tableFitToWidth: true },
      });

      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const items = document.querySelectorAll(".table-context-menu-item");
      // Should be 14 items (no Fit to Width)
      expect(items.length).toBe(14);

      // Restore
      (useSettingsStore as { getState: typeof originalGetState }).getState = originalGetState;
    });
  });

  describe("Menu rebuilds on each show()", () => {
    it("rebuilds menu items fresh on each show", async () => {
      menu.show(50, 50);
      await new Promise((r) => requestAnimationFrame(r));

      const firstItems = document.querySelectorAll(".table-context-menu-item").length;

      menu.hide();
      menu.show(200, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const secondItems = document.querySelectorAll(".table-context-menu-item").length;
      expect(firstItems).toBe(secondItems);
    });
  });

  describe("Positioning without editor container", () => {
    it("falls back to document.body when no editor-container", async () => {
      // Create view with dom not inside editor-container
      const standaloneEditorDom = document.createElement("div");
      document.body.appendChild(standaloneEditorDom);
      const standaloneView = createMockView(standaloneEditorDom);
      const standaloneMenu = new TiptapTableContextMenu(
        standaloneView as unknown as ConstructorParameters<typeof TiptapTableContextMenu>[0]
      );

      standaloneMenu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const container = document.querySelector(".table-context-menu") as HTMLElement;
      expect(container).not.toBeNull();
      // Should use fixed positioning when mounted to body
      expect(container.style.position).toBe("fixed");

      standaloneMenu.destroy();
      standaloneEditorDom.remove();
    });
  });

  describe("Mousedown prevention on menu items", () => {
    it("prevents default on mousedown to avoid editor blur", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      const items = document.querySelectorAll(".table-context-menu-item");
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      const preventSpy = vi.spyOn(event, "preventDefault");

      items[0].dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
    });
  });

  describe("Escape when editor is disconnected", () => {
    it("does not focus editor when dom is disconnected", async () => {
      menu.show(100, 200);
      await new Promise((r) => requestAnimationFrame(r));

      // Simulate disconnected dom
      Object.defineProperty(view.dom, "isConnected", { value: false, configurable: true });

      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.dispatchEvent(escapeEvent);

      expect(view.focus).not.toHaveBeenCalled();
    });
  });
});
