/**
 * Genie Picker
 *
 * Spotlight-style centered overlay for browsing and invoking AI genies.
 * Opens via Cmd+Y, supports keyboard navigation, search, and freeform input.
 *
 * Uses a single unified textarea that doubles as search (when genies match)
 * and freeform prompt input (when no matches). Two-step Enter confirmation
 * for freeform: first Enter shows hint, second Enter submits.
 *
 * Integrates mode state machine from geniePickerStore to show inline
 * GenieResponseView for processing/preview/error states.
 *
 * The component owns layout. Input state and the genie list live in
 * `useGeniePickerState`, actions and key handling in `useGeniePickerActions`,
 * and the focus hand-off in `useGeniePickerFocus`.
 *
 * @module components/GeniePicker/GeniePicker
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useGeniePickerStore } from "@/stores/geniePickerStore";
import { useAiInvocationStore, useAiProviderStore } from "@/stores/aiStore";
import { usePromptHistory } from "@/hooks/usePromptHistory";
import { useImeComposition } from "@/hooks/useImeComposition";
import { useDismissOnOutsideOrEscape } from "@/hooks/useDismissOnOutsideOrEscape";
import { useInvocationSession } from "./useInvocationSession";
import { useGeniePickerActions } from "./useGeniePickerActions";
import { useGeniePickerFocus } from "./useGeniePickerFocus";
import { useGeniePickerState } from "./useGeniePickerState";
import { GenieChips } from "./GenieChips";
import { GenieItem } from "./GenieItem";
import { GenieResponseView } from "./GenieResponseView";
import { PromptHistoryDropdown } from "./PromptHistoryDropdown";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { isResponseMode } from "./invocationLifecycle";
import "./genie-picker.css";

/** Spotlight-style overlay for browsing, searching, and invoking AI genies or freeform prompts. */
export function GeniePicker() {
  const { t } = useTranslation("ai");
  const isOpen = useGeniePickerStore((s) => s.isOpen);
  const filterScope = useGeniePickerStore((s) => s.filterScope);
  const mode = useGeniePickerStore((s) => s.mode);
  const responseText = useGeniePickerStore((s) => s.responseText);
  const pickerError = useGeniePickerStore((s) => s.pickerError);
  const submittedPrompt = useGeniePickerStore((s) => s.submittedPrompt);

  const elapsedSeconds = useAiInvocationStore((s) => s.elapsedSeconds);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Which open of the picker this is, and which suggestion it created.
  const session = useInvocationSession(isOpen);

  const activeProvider = useAiProviderStore((s) => s.activeProvider);
  const activeProviderName = useAiProviderStore((s) => {
    if (!s.activeProvider) return null;
    return (
      s.cliProviders.find((p) => p.type === s.activeProvider)?.name ??
      s.restProviders.find((p) => p.type === s.activeProvider)?.name ??
      s.activeProvider
    );
  });
  const ime = useImeComposition();

  // Prompt history hook (pass grace-period guard for freeform keyDown)
  const promptHistory = usePromptHistory(ime.isComposing);

  useGeniePickerFocus(isOpen, inputRef);
  const state = useGeniePickerState(isOpen, filterScope, promptHistory, t("picker.uncategorized"));
  const {
    genies, loading, filter, query, recents, grouped, flatList,
    selectedIndex, setSelectedIndex, activeScope, freeformConfirmed,
    showProviderSwitcher, setShowProviderSwitcher,
  } = state;
  const {
    handleClose, handleSelect, handleKeyDown,
    handleAccept, handleRetry, handleRejectPreview, handleCancelAi, handleDismiss,
  } = useGeniePickerActions({ state, mode, session, inputRef, ime, promptHistory });

  // Click outside to close (Escape is handled by the mode-aware onKeyDown, so only
  // the outside-click half is delegated). Deferred attach prevents the opening click
  // from immediately dismissing; bubble phase matches the original code.
  useDismissOnOutsideOrEscape(isOpen, containerRef, handleDismiss, {
    deferActivation: true,
    escape: false,
    capture: false,
  });

  // Scroll the selected item into view — on a list change as well as an index
  // change. Scoping or filtering replaces the list while the index stays put,
  // and the newly-selected row was left off screen.
  useEffect(() => {
    if (!listRef.current || selectedIndex < 0) return;
    const item = listRef.current.querySelector(
      `[data-index="${selectedIndex}"]`
    );
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, flatList]);

  if (!isOpen) return null;

  let itemIndex = 0;

  const isInputMode = mode === "search" || mode === "freeform";
  const inResponseMode = isResponseMode(mode);

  const historyDropdown = promptHistory.isDropdownOpen ? <PromptHistoryDropdown entries={promptHistory.dropdownEntries} selectedIndex={promptHistory.dropdownSelectedIndex} onSelect={promptHistory.selectDropdownEntry} onClose={promptHistory.closeDropdown} clearHistory={promptHistory.clearHistory} /> : null;
  const ghostTextEl = promptHistory.ghostText ? <span className="genie-freeform-ghost" aria-hidden="true"><span className="genie-freeform-ghost-spacer">{filter}</span><span className="genie-freeform-ghost-text">{promptHistory.ghostText}</span></span> : null;

  return createPortal(
    <div className="vm-overlay vm-overlay--top genie-picker-backdrop">
      <div
        ref={containerRef}
        className="vm-overlay__panel genie-picker"
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={t("picker.ariaLabel")}
      >
        {/* Unified input (search + freeform) */}
        <div className="genie-picker-header">
          {historyDropdown}
          <div className="genie-picker-input-wrapper">
            <textarea
              ref={inputRef}
              className="genie-picker-search"
              placeholder={t("picker.searchPlaceholder")}
              value={filter}
              onChange={(e) => state.changeFilter(e.target.value)}
              onKeyDown={(e) => {
                if (isInputMode && flatList.length === 0) {
                  promptHistory.handleKeyDown(e);
                }
              }}
              onFocus={() => setSelectedIndex(0)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              rows={1}
              role={/* response mode renders no listbox to control */ isInputMode ? "combobox" : undefined}
              aria-expanded={isInputMode ? flatList.length > 0 || promptHistory.isDropdownOpen : undefined}
              aria-controls={isInputMode ? "genie-picker-list" : undefined}
              aria-activedescendant={isInputMode && flatList.length > 0 && selectedIndex >= 0 ? `genie-item-${selectedIndex}` : undefined}
            />
            {ghostTextEl}
          </div>
        </div>

        {/* Body: genie list or response view */}
        <div className="genie-picker-body">
          {isInputMode && (
            <>
              {/* Quick chips (only when selection scope and no filter) */}
              {activeScope === "selection" && query === "" && (
                <GenieChips genies={genies} onSelect={handleSelect} />
              )}

              {/* Genie list */}
              <div className="vm-scroll--thin genie-picker-list" ref={listRef} id="genie-picker-list" role="listbox">
                {loading && (
                  <div className="genie-picker-empty">{t("picker.loading")}</div>
                )}

                {!loading && flatList.length === 0 && query === "" && (
                  <div className="genie-picker-empty">
                    {t("picker.empty")}
                  </div>
                )}

                {/* No match — freeform hint. Gated on the TRIMMED query, the
                    same value submission uses: a whitespace-only prompt used to
                    show an actionable hint whose Enter did nothing. */}
                {!loading && flatList.length === 0 && query !== "" && (
                  <div className="genie-picker-no-match">
                    {t("picker.noMatch")}{" "}
                    {freeformConfirmed ? (
                      <span className="genie-picker-confirm-hint">
                        {t("picker.freeformConfirm")}
                      </span>
                    ) : (
                      <span>
                        {t("picker.freeformHintPrefix")}{" "}
                        <kbd className="vm-overlay__kbd">Enter</kbd>{" "}
                        {t("picker.freeformHintSuffix")}
                      </span>
                    )}
                  </div>
                )}

                {/* Recents section */}
                {recents.length > 0 && (
                  <>
                    <div className="genie-picker-section-title">{t("picker.recentlyUsed")}</div>
                    {recents.map((genie) => {
                      const idx = itemIndex++;
                      return (
                        <GenieItem
                          key={`recent-${genie.metadata.name}`}
                          genie={genie}
                          index={idx}
                          selected={selectedIndex >= 0 && idx === selectedIndex}
                          onSelect={handleSelect}
                          onHover={setSelectedIndex}
                        />
                      );
                    })}
                  </>
                )}

                {/* Category sections */}
                {Array.from(grouped.entries()).map(([category, list]) => (
                  <div key={category}>
                    <div className="genie-picker-section-title">{category}</div>
                    {list.map((genie) => {
                      const idx = itemIndex++;
                      return (
                        <GenieItem
                          key={genie.filePath}
                          genie={genie}
                          index={idx}
                          selected={selectedIndex >= 0 && idx === selectedIndex}
                          onSelect={handleSelect}
                          onHover={setSelectedIndex}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          {inResponseMode && (
            <GenieResponseView
              mode={mode}
              responseText={responseText}
              elapsedSeconds={elapsedSeconds}
              error={pickerError}
              submittedPrompt={submittedPrompt}
              onAccept={handleAccept}
              onReject={handleRejectPreview}
              onRetry={handleRetry}
              onCancel={handleCancelAi}
            />
          )}
        </div>

        {/* Footer */}
        <div className="vm-overlay__footer genie-picker-footer">
          <span className="genie-picker-scope">
            {t("picker.scopeLabel", { scope: activeScope ?? "all" })}
          </span>
          {activeProvider && (
            <span className="provider-switcher-anchor">
              <button
                type="button"
                className="provider-switcher-trigger"
                aria-haspopup="menu"
                aria-expanded={showProviderSwitcher}
                onClick={() => setShowProviderSwitcher((v) => !v)}
              >
                {t("picker.via", { name: activeProviderName })}
              </button>
              {showProviderSwitcher && (
                <ProviderSwitcher
                  onClose={() => setShowProviderSwitcher(false)}
                  onCloseAll={handleClose}
                />
              )}
            </span>
          )}
          <span className="genie-picker-hint">
            <kbd className="vm-overlay__kbd">Tab</kbd> {t("picker.footerCycleScope")}
            {" "}
            <kbd className="vm-overlay__kbd">&uarr;&darr;</kbd> {t("picker.footerNavigate")}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
