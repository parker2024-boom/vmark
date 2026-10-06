/**
 * Truncate text without breaking a character.
 *
 * Purpose: the one way to cut a string to a length budget. `text.slice(0, n)`
 * counts UTF-16 code units, so it can stop between the two halves of a
 * surrogate pair and leave a lone surrogate behind. That is not a string Rust
 * accepts: a file name built this way is rejected by serde when it crosses
 * IPC, and anywhere it is merely stored it decays to U+FFFD.
 *
 * Key decisions:
 *   - The budget stays in UTF-16 code units (`String.length`), the unit the
 *     callers' limits were written in. Counting code points or graphemes would
 *     let an all-emoji name grow fourfold in bytes and overshoot the
 *     filesystem's name limit the budget exists to respect.
 *   - The cut lands on a GRAPHEME boundary. A user-perceived character can be
 *     several code points (a family emoji, a flag, a letter with a combining
 *     accent); cutting between them is valid Unicode but shows a different
 *     character than the one that was there.
 *   - When a single grapheme is longer than the budget there is no boundary to
 *     use, and returning nothing would discard a name that consists of that
 *     grapheme. The cut then falls back to the last whole code point — the
 *     weaker guarantee, still never a lone surrogate.
 *   - Only the prefix is handed to the segmenter. Whether a position is a
 *     boundary depends on the text before it and the one code point after it,
 *     so the megabytes behind the cut are never read.
 *
 * Known limitations:
 *   - Where `Intl.Segmenter` is missing, the cut is code-point-safe only. Every
 *     WebView the app targets has it; the fallback keeps the function total.
 *   - An input that already contains a lone surrogate is not repaired.
 *
 * @module utils/truncateText
 */

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** True when a surrogate pair starts at `index - 1`, i.e. `index` is inside it. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return (
    before >= HIGH_SURROGATE_MIN &&
    before <= HIGH_SURROGATE_MAX &&
    after >= LOW_SURROGATE_MIN &&
    after <= LOW_SURROGATE_MAX
  );
}

/** The largest index `<= limit` that is not inside a surrogate pair. */
function codePointBoundary(text: string, limit: number): number {
  return splitsSurrogatePair(text, limit) ? limit - 1 : limit;
}

/**
 * The largest grapheme boundary `<= limit`, or 0 when the first grapheme is
 * itself longer than `limit`. `limit` must be less than `text.length`.
 */
function graphemeBoundary(segmenter: Intl.Segmenter, text: string, limit: number): number {
  // The window ends after the whole code point that starts at or before
  // `limit`: a boundary at `limit` is decided by that code point, and half of
  // a surrogate pair would be judged as a different character.
  const windowEnd = Math.min(text.length, limit + 1);
  const window = text.slice(0, splitsSurrogatePair(text, windowEnd) ? windowEnd + 1 : windowEnd);
  let boundary = 0;
  for (const { index } of segmenter.segment(window)) {
    if (index > limit) break;
    boundary = index;
  }
  return boundary;
}

/**
 * The longest prefix of `text` that is at most `maxLength` UTF-16 code units
 * and does not end inside a character — see the header for what "character"
 * means and when the guarantee weakens.
 *
 * A budget that is not a positive number yields the empty string.
 */
export function truncateToLength(text: string, maxLength: number): string {
  if (!(maxLength > 0)) return "";
  if (text.length <= maxLength) return text;

  const limit = Math.floor(maxLength);
  const boundary = graphemeSegmenter ? graphemeBoundary(graphemeSegmenter, text, limit) : 0;
  return text.slice(0, boundary > 0 ? boundary : codePointBoundary(text, limit));
}
