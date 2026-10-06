/**
 * Universal toolbar open/close session.
 *
 * Purpose: what happens as the toolbar opens, keeps focus, loses focus and
 * closes — seeding the focused button on open (closing again with a toast
 * when nothing is enabled), restoring it from session memory while open,
 * recording navigation into the session, and handing focus back to the
 * active editor when the toolbar keeps its place but loses focus.
 *
 * Key decisions:
 *   - Shift+Cmd+P toggles FOCUS, not visibility; the toolbar can stay visible
 *     with focus in the editor, so focus is moved out only if it is still
 *     inside the toolbar.
 *
 * @coordinates-with src/components/Editor/UniversalToolbar/toolbarFocus.ts — initial focus choice
 * @coordinates-with src/components/Editor/UniversalToolbar/UniversalToolbar.tsx — the consumer
 * @module components/Editor/UniversalToolbar/useToolbarSession
 */
import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "@/stores/uiStore";
import { selectSourceEditing } from "@/stores/selectSourceEditing";
import { useEditorStore } from "@/stores/editorStore";
import { imeToast as toast } from "@/services/ime/imeToast";
import { getInitialFocusIndex } from "./toolbarFocus";
import type { ToolbarButtons } from "./useToolbarButtons";

/** Focus whichever editor surface (Source or WYSIWYG) is active. */
export function focusActiveEditor(): void {
  const isSource = selectSourceEditing(useUIStore.getState());
  if (isSource) {
    useEditorStore.getState().source.editorView?.focus();
    return;
  }
  useEditorStore.getState().tiptap.editorView?.focus();
}

interface ToolbarSessionInput {
  visible: boolean;
  toolbarHasFocus: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  buttonStates: ToolbarButtons["buttonStates"];
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  closeMenu: (restoreFocus?: boolean) => void;
}

export function useToolbarSession({
  visible,
  toolbarHasFocus,
  containerRef,
  buttonStates,
  focusedIndex,
  setFocusedIndex,
  closeMenu,
}: ToolbarSessionInput): void {
  const { t: tDialog } = useTranslation("dialog");
  const sessionFocusIndex = useUIStore((state) => state.toolbarSessionFocusIndex);
  const wasVisibleRef = useRef(false);

  // Update session focus index when user navigates
  useEffect(() => {
    /* v8 ignore next -- @preserve reason: focusedIndex < 0 means no button is focused; initial state not tested via this effect */
    if (focusedIndex >= 0) {
      useUIStore.getState().setToolbarSessionFocusIndex(focusedIndex);
    }
  }, [focusedIndex]);

  // Move focus to editor when toolbar focus is toggled off (but toolbar stays visible)
  useEffect(() => {
    if (visible && !toolbarHasFocus) {
      // Check if focus is still inside the toolbar
      const container = containerRef.current;
      const activeEl = document.activeElement as HTMLElement | null;
      if (container && activeEl && container.contains(activeEl)) {
        focusActiveEditor();
      }
    }
  }, [visible, toolbarHasFocus, containerRef]);

  // Handle toolbar open/close and initial focus — reacts to the external visibility
  // toggle and seeds keyboard focus from session memory / button states (#1063).
  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false;
      closeMenu(false);
      return;
    }

    // Toolbar just opened - focus first enabled button
    if (!wasVisibleRef.current) {
      const initialIndex = getInitialFocusIndex({
        states: buttonStates,
      });

      // If no enabled buttons, close toolbar immediately
      if (initialIndex < 0) {
        useUIStore.getState().clearToolbarSession();
        toast.info(tDialog("toast.noFormattingActions"));
        return;
      }

      setFocusedIndex(initialIndex);
      useUIStore.getState().setToolbarSessionFocusIndex(initialIndex);
    } else if (sessionFocusIndex >= 0) {
      // Toolbar was already open, use session memory
      setFocusedIndex(sessionFocusIndex);
    }

    wasVisibleRef.current = true;
  }, [visible, buttonStates, setFocusedIndex, closeMenu, sessionFocusIndex, tDialog]);
}
