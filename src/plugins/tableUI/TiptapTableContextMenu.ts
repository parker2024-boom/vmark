/**
 * Tiptap Table Context Menu
 *
 * Purpose: Imperative DOM-based right-click context menu for tables in WYSIWYG mode.
 * Provides row/column add/delete, alignment, format table, per-table fit-to-width,
 * and delete table actions.
 *
 * Key decisions:
 *   - Imperative DOM rather than React to avoid re-render overhead on every table click
 *   - Uses popup host scoping so the menu positions correctly inside editor container
 *   - Click-outside and Escape dismiss the menu; actions dispatch ProseMirror transactions
 *   - Placement goes through the shared `clampMenuPosition`, bounded by the viewport
 *     and the editor's bottom edge; a menu larger than that lands on the near margin
 *
 * @coordinates-with tableActions.tiptap.ts — each menu action delegates to a table command
 * @coordinates-with tiptap.ts — mounts/destroys this menu from the table UI plugin view
 * @module plugins/tableUI/TiptapTableContextMenu
 */
import { hostSettings } from "@/plugins/shared/hostSettings";
import i18n from "@/i18n";
import type { EditorView } from "@tiptap/pm/view";
import { alignColumn, type TableAlignment, addColLeft, addColRight, addRowAbove, addRowBelow, deleteCurrentColumn, deleteCurrentRow, deleteCurrentTable, formatTable, isCurrentTableFitToWidth, toggleFitToWidth } from "./tableActions.tiptap";
import { icons } from "@/utils/icons";
import { getPopupHostForDom, toHostCoordsForDom } from "@/plugins/shared/popupHostDom";
import { clampMenuPosition, viewportMenuBounds } from "@/utils/menuPosition";

/** Gap kept between the menu and the editor container's bottom edge (~1em). */
const EDITOR_BOTTOM_GAP = 16;

interface MenuAction {
  label: string;
  icon: string;
  action: () => void;
  dividerAfter?: boolean;
  danger?: boolean;
}

export class TiptapTableContextMenu {
  private container: HTMLElement;
  private editorView: EditorView;
  private isVisible = false;
  private host: HTMLElement | null = null;

  constructor(view: EditorView) {
    this.editorView = view;
    this.container = this.buildContainer();
    // Container will be appended to host in show()
    document.addEventListener("mousedown", this.handleClickOutside);
    document.addEventListener("keydown", this.handleKeydown);
  }

  updateView(view: EditorView) {
    this.editorView = view;
  }

  private buildContainer(): HTMLElement {
    const container = document.createElement("div");
    container.className = "vm-menu table-context-menu";
    container.style.display = "none";
    return container;
  }

  private buildMenu(): void {
    this.container.innerHTML = "";

    const alignCol = (alignment: TableAlignment) => () => alignColumn(this.editorView, alignment, false);
    const alignAll = (alignment: TableAlignment) => () => alignColumn(this.editorView, alignment, true);

    const actions: MenuAction[] = [
      { label: i18n.t("editor:tableMenu.insertRowAbove"), icon: icons.rowAbove, action: () => addRowAbove(this.editorView) },
      { label: i18n.t("editor:tableMenu.insertRowBelow"), icon: icons.rowBelow, action: () => addRowBelow(this.editorView) },
      { label: i18n.t("editor:tableMenu.insertColLeft"), icon: icons.colLeft, action: () => addColLeft(this.editorView) },
      { label: i18n.t("editor:tableMenu.insertColRight"), icon: icons.colRight, action: () => addColRight(this.editorView), dividerAfter: true },
      { label: i18n.t("editor:tableMenu.deleteRow"), icon: icons.deleteRow, action: () => deleteCurrentRow(this.editorView), danger: true },
      { label: i18n.t("editor:tableMenu.deleteCol"), icon: icons.deleteCol, action: () => deleteCurrentColumn(this.editorView), danger: true },
      { label: i18n.t("editor:tableMenu.deleteTable"), icon: icons.deleteTable, action: () => deleteCurrentTable(this.editorView), danger: true, dividerAfter: true },
      { label: i18n.t("editor:tableMenu.alignColLeft"), icon: icons.alignLeft, action: alignCol("left") },
      { label: i18n.t("editor:tableMenu.alignColCenter"), icon: icons.alignCenter, action: alignCol("center") },
      { label: i18n.t("editor:tableMenu.alignColRight"), icon: icons.alignRight, action: alignCol("right"), dividerAfter: true },
      { label: i18n.t("editor:tableMenu.alignAllLeft"), icon: icons.alignAllLeft, action: alignAll("left") },
      { label: i18n.t("editor:tableMenu.alignAllCenter"), icon: icons.alignAllCenter, action: alignAll("center") },
      { label: i18n.t("editor:tableMenu.alignAllRight"), icon: icons.alignAllRight, action: alignAll("right"), dividerAfter: true },
      { label: i18n.t("editor:tableMenu.formatTable"), icon: icons.formatTable, action: () => formatTable(this.editorView) },
    ];

    // Per-table fit-to-width toggle — hidden when global toggle is ON
    const globalFit = hostSettings.tableFitToWidth();
    if (!globalFit) {
      const isFit = isCurrentTableFitToWidth(this.editorView);
      actions.push({
        label: isFit ? i18n.t("editor:tableMenu.naturalWidth") : i18n.t("editor:tableMenu.fitToWidth"),
        icon: icons.fitToWidth,
        action: () => toggleFitToWidth(this.editorView),
      });
    }

    for (const item of actions) {
      const menuItem = document.createElement("button");
      menuItem.className = `table-context-menu-item${item.danger ? " table-context-menu-item-danger" : ""}`;
      menuItem.type = "button";

      const iconSpan = document.createElement("span");
      iconSpan.className = "table-context-menu-icon";
      iconSpan.innerHTML = item.icon;
      menuItem.appendChild(iconSpan);

      const labelSpan = document.createElement("span");
      labelSpan.className = "table-context-menu-label";
      labelSpan.textContent = item.label;
      menuItem.appendChild(labelSpan);

      menuItem.addEventListener("mousedown", (e) => e.preventDefault());
      menuItem.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.action();
        this.hide();
      });

      this.container.appendChild(menuItem);

      if (item.dividerAfter) {
        const divider = document.createElement("div");
        divider.className = "table-context-menu-divider";
        this.container.appendChild(divider);
      }
    }
  }

  show(x: number, y: number) {
    this.buildMenu();

    // Mount to editor container if available, otherwise document.body
    this.host = getPopupHostForDom(this.editorView.dom) ?? document.body;
    if (this.container.parentElement !== this.host) {
      this.container.style.position = this.host === document.body ? "fixed" : "absolute";
      this.host.appendChild(this.container);
    }

    this.container.style.display = "flex";

    // Convert to host-relative coordinates if mounted inside editor container
    if (this.host !== document.body) {
      const hostPos = toHostCoordsForDom(this.host, { top: y, left: x });
      this.container.style.left = `${hostPos.left}px`;
      this.container.style.top = `${hostPos.top}px`;
    } else {
      this.container.style.left = `${x}px`;
      this.container.style.top = `${y}px`;
    }

    requestAnimationFrame(() => {
      // Measured after layout, in viewport coordinates.
      const rect = this.container.getBoundingClientRect();
      const bounds = viewportMenuBounds({ width: window.innerWidth, height: window.innerHeight });

      // The menu must also clear the editor's bottom edge, with a ~1em gap.
      const editorContainer = this.editorView.dom.closest(".editor-container");
      const editorRect = editorContainer?.getBoundingClientRect();
      if (editorRect) bounds.bottom = editorRect.bottom - EDITOR_BOTTOM_GAP;

      // Anchor on the requested point, not the measured box: only the menu's
      // SIZE needs layout, and the request is what the user pointed at.
      const clamped = clampMenuPosition({ x, y }, rect, bounds);
      if (clamped.x === x && clamped.y === y) return;

      const hostPos =
        this.host && this.host !== document.body
          ? toHostCoordsForDom(this.host, { top: clamped.y, left: clamped.x })
          : { top: clamped.y, left: clamped.x };
      if (clamped.x !== x) this.container.style.left = `${hostPos.left}px`;
      if (clamped.y !== y) this.container.style.top = `${hostPos.top}px`;
    });

    this.isVisible = true;
  }

  hide() {
    this.container.style.display = "none";
    this.isVisible = false;
    this.host = null;
  }

  private handleClickOutside = (e: MouseEvent) => {
    if (!this.isVisible) return;
    const target = e.target as Node;
    if (!this.container.contains(target)) {
      this.hide();
    }
  };

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.isVisible) {
      this.hide();
      if (this.editorView.dom.isConnected) {
        this.editorView.focus();
      }
    }
  };

  destroy() {
    document.removeEventListener("mousedown", this.handleClickOutside);
    document.removeEventListener("keydown", this.handleKeydown);
    this.container.remove();
  }
}

