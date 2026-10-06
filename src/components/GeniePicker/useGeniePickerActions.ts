/**
 * Genie picker actions.
 *
 * Purpose: what the picker DOES — close, run a genie, submit a freeform
 * prompt, the response-mode exits, and the dialog's keydown handler.
 *
 * Key decisions:
 *   - Nothing is submitted while the genies are still LOADING. An empty list
 *     during a load is "we do not know yet", not "no genie matches".
 *   - A control inside the dialog owns its own keys: `preventDefault` on
 *     keydown cancels a button's click, and Tab there must move focus rather
 *     than cycle the scope. Escape stays the dialog's.
 *   - In a response mode a MODIFIED key is not typing; swallowing Cmd+C
 *     stopped the user copying the answer the picker had just produced.
 *   - The key table (`geniePickerKeys.ts`) decides what a key means; this
 *     hook decides what to do about it.
 *
 * @coordinates-with src/components/GeniePicker/GeniePicker.tsx — the consumer
 * @coordinates-with src/components/GeniePicker/useGeniePickerState.ts — the state it acts on
 * @coordinates-with src/components/GeniePicker/useInvocationSession.ts — session claims and response exits
 * @module components/GeniePicker/useGeniePickerActions
 */
import { useCallback, type RefObject } from "react";
import { useGeniePickerStore, type PickerMode } from "@/stores/geniePickerStore";
import { useGenieInvocation } from "@/hooks/useGenieInvocation";
import type { useImeComposition } from "@/hooks/useImeComposition";
import type { GenieDefinition } from "@/types/aiGenies";
import { isImeKeyEvent } from "@/utils/imeGuard";
import { genieWarn } from "@/utils/debug";
import { settleInvocation } from "./invocationLifecycle";
import { genieQuery } from "./genieListDerivation";
import { inputModeIntent, nextScope, nextSelectedIndex } from "./geniePickerKeys";
import { useResponseActions, type InvocationSession } from "./useInvocationSession";
import type { GeniePickerState, PromptHistory } from "./useGeniePickerState";

interface GeniePickerActionsInput {
  state: GeniePickerState;
  mode: PickerMode;
  session: InvocationSession;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  ime: Pick<ReturnType<typeof useImeComposition>, "isComposing">;
  promptHistory: PromptHistory;
}

export function useGeniePickerActions({
  state,
  mode,
  session,
  inputRef,
  ime,
  promptHistory,
}: GeniePickerActionsInput) {
  const {
    resetInput,
    activeScope,
    setActiveScope,
    filter,
    flatList,
    selectedIndex,
    setSelectedIndex,
    loading,
    query,
    freeformConfirmed,
    setFreeformConfirmed,
  } = state;
  const { invokeGenie, invokeFreeform, cancel: cancelInvocation } = useGenieInvocation();

  const handleClose = useCallback(() => { useGeniePickerStore.getState().closePicker(); resetInput(); }, [resetInput]);

  const handleSelect = useCallback((genie: GenieDefinition) => {
    resetInput();
    void settleInvocation(() => invokeGenie(genie, activeScope ?? undefined), (e) => genieWarn("Genie invocation failed:", e), session.claim());
  }, [resetInput, invokeGenie, activeScope, session]);

  const handleFreeformSubmit = useCallback(() => {
    const text = genieQuery(filter);
    /* v8 ignore next -- @preserve guard: freeform submit only reachable when filter is non-empty */
    if (!text) return;
    const scope = activeScope ?? "selection";
    promptHistory.recordAndReset(text);
    resetInput();
    void settleInvocation(() => invokeFreeform(text, scope), (e) => genieWarn("Freeform genie invocation failed:", e), session.claim());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- promptHistory is a fresh object each render; listing it would rebuild the handler every render
  }, [filter, activeScope, resetInput, invokeFreeform, session]);

  // Every exit from a response mode.
  const responseActions = useResponseActions(mode, session, cancelInvocation, handleClose);

  /** Enter in input mode: run the highlighted genie, or take the two-step freeform path. */
  const submitSelection = useCallback(() => {
    if (flatList.length > 0) {
      const selected = flatList[selectedIndex];
      /* v8 ignore next -- @preserve guard: selectedIndex always valid when flatList.length > 0 */
      if (selected) handleSelect(selected);
      return;
    }
    if (loading || query === "") return;
    if (!freeformConfirmed) setFreeformConfirmed(true);
    else handleFreeformSubmit();
  }, [flatList, selectedIndex, handleSelect, loading, query, freeformConfirmed, setFreeformConfirmed, handleFreeformSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeKeyEvent(e.nativeEvent) || ime.isComposing()) return;

      const target = e.target;
      const fromControl =
        target instanceof HTMLElement &&
        target !== inputRef.current &&
        target.closest("button, a[href], [role='menuitem']") !== null;
      if (fromControl && e.key !== "Escape") return;

      // In non-input modes, Escape returns to input; all other keys are blocked
      if (mode === "processing" || mode === "preview" || mode === "error") {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        if (e.key === "Escape") {
          if (mode === "processing") cancelInvocation();
          else session.rejectSuggestion();
          useGeniePickerStore.getState().resetToInput();
        }
        return;
      }

      const intent = inputModeIntent(e.key, e.shiftKey);
      if (intent === null) return;
      e.preventDefault();

      if (intent === "close") {
        handleClose();
      } else if (intent === "cycle-scope") {
        setActiveScope(nextScope(activeScope));
      } else if (intent === "submit") {
        submitSelection();
      } else {
        setSelectedIndex((prev) => nextSelectedIndex(prev, intent, flatList.length));
      }
    },
    [flatList.length, handleClose, activeScope, setActiveScope, setSelectedIndex, submitSelection, ime, inputRef, mode, cancelInvocation, session]
  );

  return { handleClose, handleSelect, handleKeyDown, ...responseActions };
}
