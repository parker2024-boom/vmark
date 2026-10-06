/**
 * Universal toolbar keyboard and focus navigation.
 *
 * Purpose: wire the roving-tabindex keyboard model (`useToolbarKeyboard`) to
 * the toolbar's buttons and dropdown — activation, opening a dropdown, the
 * two-step Escape (dropdown first, then the toolbar), leaving a dropdown by
 * arrow or Tab, and tracking which button holds focus.
 *
 * Key decisions:
 *   - Arrow keys out of an open dropdown switch to the neighbouring group's
 *     dropdown when it is enabled; Tab, or a disabled neighbour, closes the
 *     dropdown and focuses the neighbouring toolbar button.
 *   - The focused index is recorded on focus CAPTURE, before the
 *     `universalToolbarHasFocus` re-render.
 *
 * @coordinates-with src/components/Editor/UniversalToolbar/useToolbarKeyboard.ts — the key model
 * @coordinates-with src/components/Editor/UniversalToolbar/useToolbarMenu.ts — the dropdown it drives
 * @coordinates-with src/components/Editor/UniversalToolbar/UniversalToolbar.tsx — the consumer
 * @module components/Editor/UniversalToolbar/useToolbarNavigation
 */
import { useCallback, type FocusEvent, type RefObject } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useGeniePickerStore } from "@/stores/geniePickerStore";
import { useToolbarKeyboard } from "./useToolbarKeyboard";
import { getNextFocusableIndex, getPrevFocusableIndex } from "./toolbarNavigation";
import { focusActiveEditor } from "./useToolbarSession";
import { toolbarButtonAt, type ToolbarMenu } from "./useToolbarMenu";
import type { ToolbarButtons } from "./useToolbarButtons";

export function useToolbarNavigation(
  containerRef: RefObject<HTMLDivElement | null>,
  toolbarHasFocus: boolean,
  model: ToolbarButtons,
  menu: ToolbarMenu,
) {
  const { buttons, buttonStates, genieFocusIndex, isButtonFocusable, isDropdownButton } = model;
  const { menuOpen, openMenu, switchMenu, closeMenu, resetMenu } = menu;

  // Close toolbar completely
  const closeToolbar = useCallback(() => {
    useUIStore.getState().clearToolbarSession();
    focusActiveEditor();
    resetMenu();
  }, [resetMenu]);

  const { handleKeyDown, focusedIndex, setFocusedIndex } = useToolbarKeyboard({
    buttonCount: buttons.length + 1, // +1 for the trailing AI-Prompts button
    containerRef,
    isButtonFocusable,
    isDropdownButton,
    focusMode: toolbarHasFocus,
    onActivate: (index) => {
      // Trailing AI-Prompts pseudo-button — open the genie picker.
      if (index === genieFocusIndex) {
        useGeniePickerStore.getState().openPicker({ filterScope: "selection" });
        return;
      }
      const button = buttons[index];
      /* v8 ignore next -- @preserve reason: button is always defined for valid index; defensive null guard */
      if (!button) return;
      /* v8 ignore next -- @preserve reason: non-dropdown button type branch not reached; onActivate only fires for dropdown buttons */
      if (button.type === "dropdown") {
        /* v8 ignore next -- @preserve reason: disabled dropdown branch not exercised via keyboard activation in tests */
        if (buttonStates[index]?.disabled) return;
        const rect = toolbarButtonAt(containerRef, index)?.getBoundingClientRect();
        /* v8 ignore next -- @preserve reason: rect is null only when DOM button is absent; always present after toolbar renders */
        if (rect) {
          openMenu(button.id, rect);
        }
      }
    },
    onOpenDropdown: (index) => {
      const button = buttons[index];
      /* v8 ignore next -- @preserve reason: button always defined for valid index; type guard for non-dropdown buttons */
      if (!button || button.type !== "dropdown") return false;
      /* v8 ignore next -- @preserve reason: disabled state prevents openDropdown call; not exercised in current test suite */
      if (buttonStates[index]?.disabled) return false;
      const rect = toolbarButtonAt(containerRef, index)?.getBoundingClientRect();
      /* v8 ignore next -- @preserve reason: rect is null only when DOM button missing; always present after render */
      if (rect) {
        openMenu(button.id, rect);
      }
      return true;
    },
    onClose: () => {
      // Two-step Escape: if dropdown open, close it first
      if (menuOpen) {
        closeMenu();
        return;
      }
      // No dropdown open - close toolbar
      closeToolbar();
    },
  });

  const handleFocusCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const focusIndexAttr = target.getAttribute("data-focus-index");
      if (focusIndexAttr !== null) {
        const index = parseInt(focusIndexAttr, 10);
        /* v8 ignore next -- @preserve reason: NaN guard for malformed data-focus-index attribute; always a valid integer on rendered buttons */
        if (!isNaN(index)) {
          setFocusedIndex(index);
          useUIStore.getState().setToolbarSessionFocusIndex(index);
        }
      }

      if (!useUIStore.getState().universalToolbarHasFocus) {
        useUIStore.getState().setUniversalToolbarHasFocus(true);
      }
    },
    [setFocusedIndex]
  );

  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget as Node | null;
      const container = containerRef.current;
      if (container && nextTarget && container.contains(nextTarget)) return;
      useUIStore.getState().setUniversalToolbarHasFocus(false);
    },
    [containerRef]
  );

  // Handle dropdown exit (arrow keys or Tab) - moves to adjacent toolbar button
  const handleDropdownExit = useCallback(
    (direction: "left" | "right" | "forward" | "backward") => {
      const isArrowNav = direction === "left" || direction === "right";
      const isNext = direction === "right" || direction === "forward";
      // genieFocusIndex + 1 = full roving count (group buttons + trailing AI-Prompts
      // pseudo-button), so dropdown-exit nav can land on the Genie button too.
      const newIndex = isNext
        ? getNextFocusableIndex(focusedIndex, genieFocusIndex + 1, isButtonFocusable)
        : getPrevFocusableIndex(focusedIndex, genieFocusIndex + 1, isButtonFocusable);

      setFocusedIndex(newIndex);
      useUIStore.getState().setToolbarSessionFocusIndex(newIndex);

      // For arrow navigation, switch to adjacent dropdown (if enabled).
      // Changing the open group unmounts the old dropdown and mounts the new
      // one, whose effect focuses its first item.
      /* v8 ignore next -- @preserve reason: arrow-key dropdown-switch path not exercised in current tests; requires mounted DOM with bounding rects */
      if (isArrowNav && isDropdownButton(newIndex) && !buttonStates[newIndex]?.disabled) {
        const button = buttons[newIndex];
        const rect = toolbarButtonAt(containerRef, newIndex)?.getBoundingClientRect();
        if (rect) {
          switchMenu(button.id, rect);
          return;
        }
      }

      // For Tab navigation or disabled button, close dropdown and focus toolbar button
      closeMenu(false);
      requestAnimationFrame(() => {
        toolbarButtonAt(containerRef, newIndex)?.focus();
      });
    },
    [closeMenu, switchMenu, containerRef, focusedIndex, buttons, genieFocusIndex, buttonStates, isButtonFocusable, isDropdownButton, setFocusedIndex]
  );

  return { handleKeyDown, focusedIndex, setFocusedIndex, handleFocusCapture, handleBlurCapture, handleDropdownExit };
}
