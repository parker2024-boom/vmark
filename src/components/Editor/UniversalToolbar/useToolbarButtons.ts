/**
 * Universal toolbar button model.
 *
 * Purpose: the toolbar's buttons, the editor context they are evaluated
 * against (Source or WYSIWYG, with multi-selection), each button's enabled /
 * active state, and the roving-focus predicates built on them.
 *
 * Key decisions:
 *   - The AI-Prompts button is a trailing pseudo-button at index
 *     `buttons.length` in the roving-tabindex model, so arrow navigation
 *     reaches it. It is always focusable and never a dropdown.
 *
 * @coordinates-with src/components/Editor/UniversalToolbar/UniversalToolbar.tsx — the consumer
 * @module components/Editor/UniversalToolbar/useToolbarButtons
 */
import { useCallback, useMemo } from "react";
import { useUIStore } from "@/stores/uiStore";
import { selectSourceEditing } from "@/stores/selectSourceEditing";
import { useEditorStore } from "@/stores/editorStore";
import { getToolbarButtonState } from "@/plugins/toolbarActions/enableRules";
import { getSourceMultiSelectionContext, getWysiwygMultiSelectionContext } from "@/plugins/toolbarActions/multiSelectionContext";
import type { ToolbarContext } from "@/plugins/toolbarActions/types";
import { getGroupButtons } from "./toolbarGroups";

export function useToolbarButtons() {
  const sourceMode = useUIStore(selectSourceEditing);
  const wysiwygContext = useEditorStore((state) => state.tiptap.context);
  const wysiwygView = useEditorStore((state) => state.tiptap.editorView);
  const wysiwygEditor = useEditorStore((state) => state.tiptap.editor);
  const sourceContext = useEditorStore((state) => state.source.context);
  const sourceView = useEditorStore((state) => state.source.editorView);

  // One toolbar button per group
  const buttons = useMemo(() => getGroupButtons(), []);

  const toolbarContext = useMemo<ToolbarContext>(() => {
    if (sourceMode) {
      return {
        surface: "source",
        view: sourceView,
        context: sourceContext,
        multiSelection: getSourceMultiSelectionContext(sourceView, sourceContext),
      };
    }
    return {
      surface: "wysiwyg",
      view: wysiwygView,
      editor: wysiwygEditor,
      context: wysiwygContext,
      multiSelection: getWysiwygMultiSelectionContext(wysiwygView, wysiwygContext),
    };
  }, [sourceMode, sourceView, sourceContext, wysiwygView, wysiwygEditor, wysiwygContext]);

  const buttonStates = useMemo(
    () => buttons.map((button) => getToolbarButtonState(button, toolbarContext)),
    [buttons, toolbarContext]
  );

  const genieFocusIndex = buttons.length;

  const isButtonFocusable = useCallback(
    (index: number) => (index === genieFocusIndex ? true : !buttonStates[index]?.disabled),
    [buttonStates, genieFocusIndex]
  );

  const isDropdownButton = useCallback(
    (index: number) => (index === genieFocusIndex ? false : buttons[index]?.type === "dropdown"),
    [buttons, genieFocusIndex]
  );

  return { buttons, toolbarContext, buttonStates, genieFocusIndex, isButtonFocusable, isDropdownButton };
}

export type ToolbarButtons = ReturnType<typeof useToolbarButtons>;
