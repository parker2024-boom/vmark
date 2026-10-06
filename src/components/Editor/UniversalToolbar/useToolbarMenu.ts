/**
 * Universal toolbar dropdown state.
 *
 * Purpose: which group's dropdown is open and where it is anchored, opening
 * and closing it in step with `uiStore.toolbarDropdownOpen`, and the three
 * ways it closes on its own — the store flag dropping (global Escape), focus
 * leaving the toolbar, and a click outside both the dropdown and the toolbar.
 *
 * Key decisions:
 *   - `closeMenu` restores focus to the session's toolbar button on the next
 *     frame unless told not to, and only while the toolbar is still visible.
 *   - A click on a toolbar button is left to that button's own click handler.
 *
 * @coordinates-with src/components/Editor/UniversalToolbar/UniversalToolbar.tsx — the consumer
 * @module components/Editor/UniversalToolbar/useToolbarMenu
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useUIStore } from "@/stores/uiStore";
import { getToolbarItemState } from "@/plugins/toolbarActions/enableRules";
import type { ToolbarContext } from "@/plugins/toolbarActions/types";
import { TOOLBAR_GROUPS } from "./toolbarGroups";

/** The rendered toolbar button at roving index `index`, if any. */
export function toolbarButtonAt(
  containerRef: RefObject<HTMLDivElement | null>,
  index: number,
): HTMLButtonElement | null | undefined {
  return containerRef.current?.querySelector<HTMLButtonElement>(
    `.universal-toolbar-btn[data-focus-index="${index}"]`
  );
}

export function useToolbarMenu(
  containerRef: RefObject<HTMLDivElement | null>,
  toolbarHasFocus: boolean,
  toolbarContext: ToolbarContext,
) {
  const storeDropdownOpen = useUIStore((state) => state.toolbarDropdownOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown, optionally restore focus to toolbar button
  const closeMenu = useCallback((restoreFocus = true) => {
    setMenuOpen(false);
    setOpenGroupId(null);
    useUIStore.getState().setToolbarDropdownOpen(false);
    if (!restoreFocus || !useUIStore.getState().universalToolbarVisible) return;
    requestAnimationFrame(() => {
      /* v8 ignore next -- @preserve reason: visibility check inside rAF; toolbar may close before frame fires — timing-dependent, not testable in jsdom */
      if (!useUIStore.getState().universalToolbarVisible) return;
      const currentIndex = useUIStore.getState().toolbarSessionFocusIndex;
      if (currentIndex < 0) return;
      toolbarButtonAt(containerRef, currentIndex)?.focus();
    });
  }, [containerRef]);

  // Open a group's dropdown and sync with the store
  const openMenu = useCallback((groupId: string, rect: DOMRect) => {
    setMenuAnchor(rect);
    setOpenGroupId(groupId);
    setMenuOpen(true);
    useUIStore.getState().setToolbarDropdownOpen(true);
  }, []);

  /** Switch the open dropdown to another group without closing it. */
  const switchMenu = useCallback((groupId: string, rect: DOMRect) => {
    setOpenGroupId(groupId);
    setMenuAnchor(rect);
  }, []);

  /** Drop local dropdown state without touching the store or focus (the toolbar is closing). */
  const resetMenu = useCallback(() => {
    setMenuOpen(false);
    setOpenGroupId(null);
  }, []);

  // Sync local dropdown state from the external store (for global Escape handling).
  useEffect(() => {
    if (!storeDropdownOpen && menuOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacts to external store dropdown state (#1063)
      closeMenu();
    }
  }, [storeDropdownOpen, menuOpen, closeMenu]);

  // Close dropdown when focus leaves the toolbar (focus toggle).
  useEffect(() => {
    if (!toolbarHasFocus && menuOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacts to external toolbar-focus signal (#1063)
      closeMenu(false);
    }
  }, [toolbarHasFocus, menuOpen, closeMenu]);

  // Handle click outside dropdown
  useEffect(() => {
    if (!menuOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const menu = menuRef.current;
      const container = containerRef.current;

      // Click inside dropdown - ignore
      if (menu && menu.contains(target)) return;

      // Click on toolbar button - let onClick handler deal with it
      if (container && container.contains(target)) {
        return;
      }

      // Click outside - close dropdown, keep toolbar
      closeMenu();
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [menuOpen, closeMenu, containerRef]);

  /* v8 ignore next -- @preserve reason: ?? null fallback only when openGroupId doesn't match any group; all group IDs are valid constants */
  const openGroup = openGroupId
    ? TOOLBAR_GROUPS.find((group) => group.id === openGroupId) ?? null
    : null;

  const dropdownItems = useMemo(() => {
    if (!openGroup) return [];
    return openGroup.items.map((item) => ({
      item,
      state: getToolbarItemState(item, toolbarContext),
    }));
  }, [openGroup, toolbarContext]);

  return {
    menuOpen,
    menuAnchor,
    openGroupId,
    openGroup,
    dropdownItems,
    menuRef,
    openMenu,
    switchMenu,
    closeMenu,
    resetMenu,
  };
}

export type ToolbarMenu = ReturnType<typeof useToolbarMenu>;
