/**
 * Genie picker focus hand-off.
 *
 * Purpose: remember what had focus when the picker opened, focus the picker's
 * input on the next frame, and give focus back when the picker closes.
 *
 * Key decisions:
 *   - The hand-off is keyed on `isOpen` alone. Keyed on the scope as well,
 *     re-opening at a different scope while already open re-captured
 *     `document.activeElement` — by then the picker's own textarea — so the
 *     eventual close restored focus to a detached element.
 *
 * @coordinates-with src/components/GeniePicker/GeniePicker.tsx — the consumer
 * @module components/GeniePicker/useGeniePickerFocus
 */
import { useEffect, useRef, type RefObject } from "react";

export function useGeniePickerFocus(
  isOpen: boolean,
  inputRef: RefObject<HTMLTextAreaElement | null>,
): void {
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement;
      return;
    }
    if (previousFocusRef.current) {
      const el = previousFocusRef.current as HTMLElement;
      if (typeof el.focus === "function") el.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen, inputRef]);
}
