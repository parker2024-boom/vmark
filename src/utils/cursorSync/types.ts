/**
 * cursorSync types — the text context around a cursor that cursor sync uses
 * to match a position across editors.
 *
 * @module utils/cursorSync/types
 */

/**
 * Context around cursor for better matching
 */
export interface CursorContext {
  word: string;
  offsetInWord: number;
  contextBefore: string;
  contextAfter: string;
}
