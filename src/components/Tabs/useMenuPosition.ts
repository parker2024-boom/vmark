/**
 * useMenuPosition (tab context menu entry point)
 *
 * Purpose: the tab right-click menu's name for the shared placement hook. The
 * behaviour lives in `@/hooks/useMenuPosition`, which every context menu uses;
 * this module only keeps the tab menu's import path and position type.
 *
 * @coordinates-with TabContextMenu.tsx — the tab right-click menu
 * @coordinates-with hooks/useMenuPosition.ts — the implementation
 * @module components/Tabs/useMenuPosition
 */
export { useMenuPosition, type MenuPoint as ContextMenuPosition } from "@/hooks/useMenuPosition";
