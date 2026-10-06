/**
 * Genie picker input state.
 *
 * Purpose: the picker's input-mode state machine — the typed text, the
 * highlighted row, the active scope, the two-step freeform confirmation and
 * the provider switcher — together with the genie list derived from it, the
 * reset on open, and the prompt-history sync.
 *
 * Key decisions:
 *   - ONE trimmed query drives the search, the recents section, the no-match
 *     hint and the freeform submission. They used to disagree: search and hint
 *     read the raw value while submission trimmed it, so whitespace alone hid
 *     every genie behind a hint whose Enter did nothing.
 *   - ONE statement of the match rule (`filterGenies`); it used to be written
 *     here and again in the store's `searchGenies`.
 *   - Recents subscribe to the recent NAMES: `addRecent` writes that list and
 *     leaves `genies` alone, so watching only `genies` showed a stale order.
 *   - Opening — including opening again at a different scope — resets the
 *     surface through `resetInput`, the single copy of the reset.
 *   - `loadGenies` catches its own failure and reports an empty list; the
 *     catch here is a backstop that logs.
 *
 * @coordinates-with src/components/GeniePicker/GeniePicker.tsx — the consumer
 * @coordinates-with src/components/GeniePicker/genieListDerivation.ts — the derivation rules
 * @module components/GeniePicker/useGeniePickerState
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGeniesStore } from "@/stores/aiStore";
import { useQuickOpenStore } from "@/stores/quickOpenStore";
import type { usePromptHistory } from "@/hooks/usePromptHistory";
import type { GenieScope } from "@/types/aiGenies";
import { geniesWarn } from "@/utils/debug";
import { buildGenieList, filterGenies, genieQuery, recentGeniesOf, scopedRecents } from "./genieListDerivation";

export type PromptHistory = ReturnType<typeof usePromptHistory>;

export function useGeniePickerState(
  isOpen: boolean,
  filterScope: GenieScope | null,
  promptHistory: PromptHistory,
  uncategorizedLabel: string,
) {
  const genies = useGeniesStore((s) => s.genies);
  const loading = useGeniesStore((s) => s.loading);
  const recentNames = useGeniesStore((s) => s.recentGenieNames);

  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeScope, setActiveScope] = useState<GenieScope | null>(null);
  const [showProviderSwitcher, setShowProviderSwitcher] = useState(false);
  const [freeformConfirmed, setFreeformConfirmed] = useState(false);

  // Reset the input surface without closing: the store stays open so the response view can take over.
  const resetInput = useCallback(() => {
    setFilter("");
    setSelectedIndex(0);
    setFreeformConfirmed(false);
    setShowProviderSwitcher(false);
    promptHistory.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- promptHistory is a fresh object each render; its reset() is what is called, and listing the object would make resetInput unstable
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- open-transition resets bundled with closing Quick Open and loading genies */
  useEffect(() => {
    if (!isOpen) return;
    useQuickOpenStore.getState().close();
    void Promise.resolve(useGeniesStore.getState().loadGenies()).catch((e) => geniesWarn("Failed to load genies:", e));
    resetInput();
    setActiveScope(filterScope);
  }, [isOpen, filterScope, resetInput]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const query = genieQuery(filter);
  const matches = useMemo(
    () => filterGenies(genies, query, activeScope),
    [genies, query, activeScope],
  );
  const recents = useMemo(
    () => scopedRecents(recentGeniesOf(genies, recentNames), activeScope, query),
    [genies, recentNames, activeScope, query],
  );
  const { grouped, flat: flatList } = useMemo(
    () => buildGenieList(matches, recents, uncategorizedLabel),
    [matches, recents, uncategorizedLabel],
  );

  // Clamp selectedIndex when flatList shrinks — adjusted during render, not in an effect.
  if (flatList.length > 0 && selectedIndex >= flatList.length) {
    setSelectedIndex(flatList.length - 1);
  }

  // Sync prompt-history cycling back to filter so the textarea updates. Loop-safe:
  // typing sets displayValue === filter via changeFilter, so the guard is true
  // only when cycling produces a new value.
  /* eslint-disable react-hooks/set-state-in-effect -- copies a cycled history prompt into the filter; guarded so typing never loops */
  useEffect(() => {
    if (flatList.length === 0 && promptHistory.displayValue !== filter) {
      setFilter(promptHistory.displayValue);
      setSelectedIndex(0);
      // The prompt on screen is no longer the one the user confirmed. Without
      // this, cycling history after one confirmation submitted the
      // REPLACEMENT prompt on its first Enter, with no second-Enter step.
      setFreeformConfirmed(false);
    }
  }, [promptHistory.displayValue, filter, flatList.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /** The textarea's change handler: new text starts a fresh selection and confirmation. */
  const changeFilter = (value: string) => {
    setFilter(value);
    setSelectedIndex(0);
    setFreeformConfirmed(false);
    promptHistory.handleChange(value);
  };

  return {
    genies,
    loading,
    filter,
    changeFilter,
    query,
    recents,
    grouped,
    flatList,
    selectedIndex,
    setSelectedIndex,
    activeScope,
    setActiveScope,
    freeformConfirmed,
    setFreeformConfirmed,
    showProviderSwitcher,
    setShowProviderSwitcher,
    resetInput,
  };
}

export type GeniePickerState = ReturnType<typeof useGeniePickerState>;
