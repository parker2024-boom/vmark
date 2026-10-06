/**
 * A string- and comment-aware scanner for TypeScript array and object
 * literals: the primitives the baseline ratchet's TypeScript comparators read
 * source with.
 *
 * Purpose: the ratchet pins three baselines that are TypeScript source, not
 * JSON (the i18n identical allowlist and two Markdown spec ledgers). Their
 * entries are found by walking balanced brackets while skipping strings and
 * comments, never by regex, because reasons legitimately contain quotes,
 * braces and colons. This module is that walk; the identity extraction that
 * uses it lives in `scripts/baselineRatchetTsAllowlist.mjs`.
 *
 * Every function is pure and index-based. Structural failure (an unbalanced
 * literal) THROWS, so an unreadable baseline can never compare as empty.
 *
 * @coordinates-with scripts/baselineRatchetTsAllowlist.mjs — the identity extractors built on this
 * @module scripts/lib/baselineRatchet/tsLiteralScanner
 */

const CLOSERS = { "[": "]", "{": "}", "(": ")" };
export const QUOTES = new Set(['"', "'", "`"]);

/** Index just past the string literal starting at `i`. */
export function skipString(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      i = matchingBracket(text, i + 1) + 1;
      continue;
    }
    i++;
  }
  return i;
}

/** Index just past a comment starting at `i`, or `i` when there is none. */
export function skipComment(text, i) {
  if (text[i] !== "/") return i;
  if (text[i + 1] === "/") {
    let j = i;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  }
  if (text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return i;
}

/** Index of the bracket closing the one at `start`. Throws when unbalanced. */
export function matchingBracket(text, start) {
  const open = text[start];
  const close = CLOSERS[open];
  if (!close) throw new Error(`not a bracket at offset ${start}`);
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (QUOTES.has(c)) {
      i = skipString(text, i);
      continue;
    }
    const afterComment = skipComment(text, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
    i++;
  }
  throw new Error(`unbalanced "${open}" starting at offset ${start}`);
}

/** Split at top-level commas, skipping strings, comments and nested brackets. */
export function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (QUOTES.has(c)) {
      i = skipString(text, i);
      continue;
    }
    const afterComment = skipComment(text, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (CLOSERS[c]) {
      i = matchingBracket(text, i) + 1;
      continue;
    }
    if (c === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** `name: value` split at the FIRST top-level colon, or null. */
export function splitField(text) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (QUOTES.has(c)) {
      i = skipString(text, i);
      continue;
    }
    const afterComment = skipComment(text, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (CLOSERS[c]) {
      i = matchingBracket(text, i) + 1;
      continue;
    }
    if (c === ":") return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    i++;
  }
  return null;
}

/** The text of a quoted literal, in any quote style, or null. */
export function unquote(value) {
  const q = value[0];
  if (!QUOTES.has(q) || value.length < 2) return null;
  if (skipString(value, 0) !== value.length) return null; // concatenation, etc.
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** Every string literal inside `text`, in order. */
export function stringLiteralsIn(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (QUOTES.has(text[i])) {
      const end = skipString(text, i);
      out.push(text.slice(i, end).slice(1, -1).replace(/\\(.)/g, "$1"));
      i = end;
      continue;
    }
    const afterComment = skipComment(text, i);
    i = afterComment !== i ? afterComment : i + 1;
  }
  return out;
}

/** Offset of the `[` that opens the initializer of the declaration at `decl`,
 *  or -1. Walks to the assignment `=` first, string- and comment-aware. */
export function arrayAfterAssignment(source, decl) {
  let i = decl;
  while (i < source.length) {
    const c = source[i];
    if (QUOTES.has(c)) {
      i = skipString(source, i);
      continue;
    }
    const afterComment = skipComment(source, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (c === ";") return -1; // declaration ended without an initializer
    if (c === "=" && source[i + 1] !== "=" && source[i + 1] !== ">" && !"=!<>".includes(source[i - 1])) {
      break;
    }
    i++;
  }
  i++;
  while (i < source.length) {
    const afterComment = skipComment(source, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    return source[i] === "[" ? i : -1;
  }
  return -1;
}

export function scalarOf(rawValue, field) {
  if (rawValue === undefined) return `<missing:${field}>`;
  const literal = unquote(rawValue);
  return literal ?? `<expr:${rawValue.replace(/\s+/g, " ")}>`;
}

/**
 * Offset of `const <declName>` OUTSIDE strings and comments, or -1.
 *
 * A bare `indexOf(declName)` treated `// EXPECTED_DELTAS = []` in a comment
 * as the declaration and returned an EMPTY identity set — and since removals
 * pass, that silently disabled the ledger ratchet. This walk
 * reuses the string/comment skippers so only real source can match.
 */
export function declarationIndex(source, declName) {
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (QUOTES.has(c)) {
      i = skipString(source, i);
      continue;
    }
    const afterComment = skipComment(source, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (source.startsWith("const ", i)) {
      const rest = source.slice(i + 6).replace(/^\s+/, "");
      // Identifier boundary required: `const EXPECTED_DELTAS_OLD` must not
      // match a lookup for EXPECTED_DELTAS (verify round 1).
      const after = rest[declName.length];
      if (rest.startsWith(declName) && (after === undefined || !/[\w$]/.test(after))) {
        return i + 6 + (source.slice(i + 6).length - rest.length);
      }
    }
    i++;
  }
  return -1;
}
