/**
 * markdownTextMetrics — strips markdown to plain text and counts its words and
 * characters for the document text metrics.
 *
 * @module utils/markdownTextMetrics
 */

// NOTE: components/StatusBar/incrementalTextMetrics.ts mirrors this file's fence-pairing and
// list-marker semantics for its segment model. Any behavioral change to
// stripMarkdown must keep incrementalTextMetrics.test.ts equivalence green.
import { countWords as alfaazCount } from "alfaaz";

/**
 * Strip markdown formatting to get plain text for word counting.
 *
 * Linear in the text. Four steps are scanners rather than the patterns they
 * replace, with identical output: the image and link patterns
 * (`!\[[^\]]*\]\([^)]*\)`, `\[([^\]]+)\]\([^)]*\)`) and the list-marker
 * patterns (`^[\s]*[-*+]\s+`, `^[\s]*\d+\.\s+`, multiline) were retried at
 * every start and scanned an unbounded run each time — to the end of the
 * text for a "[" with no "]" after it, or across a whole run of blank lines
 * from each of its line starts — which is quadratic.
 * `markdownTextMetrics.growth.test.ts` holds the scanners to those patterns.
 */
export function stripMarkdown(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
  const withoutLinks = stripLinks(stripImages(withoutCode));
  const withoutInline = withoutLinks
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "");
  const withoutLists = stripAtLineStarts(stripAtLineStarts(withoutInline, bulletEnd), numberedEnd);
  return withoutLists.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * `from => text.indexOf(ch, from)` for queries whose `from` never decreases,
 * in linear time overall: an answer at or after `from` is reused, and "none
 * after an earlier `from`" means none after this one either.
 */
function forwardIndexOf(text: string, ch: string): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found === -1 || found >= from) return found;
    found = text.indexOf(ch, from);
    return found;
  };
}

/** `!\[[^\]]*\]\([^)]*\)` removed, globally: an image with its alt and destination. */
function stripImages(text: string): string {
  const nextBracket = forwardIndexOf(text, "]");
  const nextParen = forwardIndexOf(text, ")");
  let out = "";
  let copied = 0;
  for (let at = text.indexOf("!["); at !== -1; ) {
    const close = nextBracket(at + 2);
    const end = close !== -1 && text[close + 1] === "(" ? nextParen(close + 2) : -1;
    if (end === -1) {
      at = text.indexOf("![", at + 1);
      continue;
    }
    out += text.slice(copied, at);
    copied = end + 1;
    at = text.indexOf("![", copied);
  }
  return out + text.slice(copied);
}

/** `\[([^\]]+)\]\([^)]*\)` replaced by its label, globally. */
function stripLinks(text: string): string {
  const nextBracket = forwardIndexOf(text, "]");
  const nextParen = forwardIndexOf(text, ")");
  let out = "";
  let copied = 0;
  for (let at = text.indexOf("["); at !== -1; ) {
    // The label is one or more characters, none of them "]".
    const close = text[at + 1] === "]" ? -1 : nextBracket(at + 1);
    const end = close !== -1 && text[close + 1] === "(" ? nextParen(close + 2) : -1;
    if (end === -1) {
      at = text.indexOf("[", at + 1);
      continue;
    }
    out += text.slice(copied, at) + text.slice(at + 1, close);
    copied = end + 1;
    at = text.indexOf("[", copied);
  }
  return out + text.slice(copied);
}

/** A run of `\s` (the JavaScript class, Unicode spaces included), anchored. */
const WHITESPACE_RUN = /\s*/y;
/** The line terminators after which a multiline `^` matches. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

/** End of the `\s*` run starting at `at`. */
function whitespaceEnd(text: string, at: number): number {
  WHITESPACE_RUN.lastIndex = at;
  WHITESPACE_RUN.exec(text);
  return WHITESPACE_RUN.lastIndex;
}

/** The first position at or after `from` where a multiline `^` matches, or -1. */
function nextLineStart(text: string, from: number): number {
  if (from > text.length) return -1;
  if (from === 0) return 0;
  LINE_TERMINATOR.lastIndex = from - 1;
  const terminator = LINE_TERMINATOR.exec(text);
  return terminator ? terminator.index + 1 : -1;
}

/** After `[-*+]\s+` at `at`, or -1. */
function bulletEnd(text: string, at: number): number {
  if (text[at] !== "-" && text[at] !== "*" && text[at] !== "+") return -1;
  const end = whitespaceEnd(text, at + 1);
  return end > at + 1 ? end : -1;
}

/** After `\d+\.\s+` at `at`, or -1. */
function numberedEnd(text: string, at: number): number {
  let i = at;
  while (text[i] >= "0" && text[i] <= "9") i++;
  if (i === at || text[i] !== ".") return -1;
  const end = whitespaceEnd(text, i + 1);
  return end > i + 1 ? end : -1;
}

/**
 * `^[\s]*MARKER` removed, globally and multiline, where `markerEnd` reads the
 * marker at the first non-space character after a line start. Every line
 * start inside one whitespace run reaches that same character, so a run that
 * is not followed by a marker is skipped whole instead of rescanned from each
 * of its line starts.
 */
function stripAtLineStarts(text: string, markerEnd: (text: string, at: number) => number): string {
  let out = "";
  let copied = 0;
  for (let from = 0; ; ) {
    const lineStart = nextLineStart(text, from);
    if (lineStart === -1) break;
    const marker = whitespaceEnd(text, lineStart);
    const end = markerEnd(text, marker);
    if (end === -1) {
      if (marker >= text.length) break;
      from = marker + 1;
      continue;
    }
    out += text.slice(copied, lineStart);
    copied = end;
    from = end;
  }
  return out + text.slice(copied);
}

// CJK scripts that count toward 字数: Han ideographs + Japanese kana.
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
// Unicode punctuation and symbols (covers ASCII + fullwidth CJK marks + emoji).
const PUNCT_OR_SYMBOL_RE = /[\p{P}\p{S}]/gu;

/**
 * Count words using alfaaz (handles CJK and other languages).
 *
 * Punctuation and symbols are stripped first: alfaaz tokenizes each glyph it
 * sees as a word, so fullwidth CJK marks (`，` `！`) and ASCII punctuation would
 * otherwise inflate the count. Stripping them matches the writer's intent — a
 * word count without punctuation.
 */
export function countWordsFromPlain(plainText: string): number {
  return alfaazCount(plainText.replace(PUNCT_OR_SYMBOL_RE, ""));
}

/**
 * Count non-whitespace characters, code-point correct.
 *
 * Uses `Array.from` so astral characters and emoji count as one each, matching
 * {@link computeTextMetrics}; `String.prototype.length` over-counts them by
 * their UTF-16 surrogate-pair length.
 */
export function countCharsFromPlain(plainText: string): number {
  return Array.from(plainText.replace(/\s/g, "")).length;
}

/**
 * Full word/character breakdown for a piece of plain text. Callers pass
 * already-`stripMarkdown`'d text so the numbers match what the reader sees,
 * not the raw markdown source.
 *
 * All character counts are code-point correct (`Array.from` / spread), so
 * astral characters and emoji count as one each — `String.prototype.length`
 * would over-count them by their UTF-16 surrogate-pair length.
 */
export interface TextMetrics {
  /**
   * Word count via alfaaz, with punctuation/symbols stripped first. Each CJK
   * character counts as one word; punctuation marks are not counted.
   */
  words: number;
  /**
   * Every character, whitespace included (code-point count). When computed
   * via the segment cache (incrementalTextMetrics.ts), inter-block
   * whitespace is normalized to one blank-line separator per block — see
   * that module's documented charsWithSpaces semantics.
   */
  charsWithSpaces: number;
  /** Characters with all whitespace (`\s`) removed. */
  charsNoSpaces: number;
  /**
   * CJK character count — the meaningful 字数 for Chinese/Japanese writers.
   * Matches Han ideographs plus Hiragana and Katakana.
   */
  cjkChars: number;
  /**
   * Characters excluding whitespace AND punctuation/symbols. Both Unicode
   * punctuation (`\p{P}`, e.g. `,` `。` `，` `！`) and symbols (`\p{S}`, e.g.
   * `$` `+` `%` and emoji) are removed, so this is a "letters & digits only"
   * count — the closest match to a writer's intuitive "real characters".
   */
  charsNoPunctuation: number;
}

/** Compute the full {@link TextMetrics} breakdown for stripped plain text. */
export function computeTextMetrics(plainText: string): TextMetrics {
  const codePoints = Array.from(plainText);
  const charsWithSpaces = codePoints.length;
  const noSpaces = plainText.replace(/\s/g, "");
  const charsNoSpaces = Array.from(noSpaces).length;
  const cjkChars = (plainText.match(CJK_RE) ?? []).length;
  const charsNoPunctuation = Array.from(
    noSpaces.replace(PUNCT_OR_SYMBOL_RE, "")
  ).length;

  return {
    // countWordsFromPlain strips punctuation/symbols itself, so fullwidth CJK
    // marks and ASCII punctuation aren't counted as words.
    words: countWordsFromPlain(plainText),
    charsWithSpaces,
    charsNoSpaces,
    cjkChars,
    charsNoPunctuation,
  };
}
