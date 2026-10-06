/**
 * Internal identifiers (work-item ids, issue numbers, decision ids, TODOs)
 * that must never reach UI copy, and the reviewed exceptions to them.
 *
 * @coordinates-with scripts/check-i18n-keys.ts — the gate CLI that runs this check
 * @module scripts/i18n-keys/internalReferences
 */

/**
 * Internal identifiers that must never reach a user (rule 35).
 *
 * "HTML preview is sandboxed but pending OWASP sign-off (WI-<id>)." shipped in
 * ten languages, beside an issue number in a shortcut description and a
 * design-decision id in a tooltip: process notes and cross-references written
 * for maintainers. Zero tolerance, no baseline — an identifier in copy is
 * never right, so there is nothing to grandfather. Decision ids are matched by
 * their prefixes (C, D, G, H, R, W) only: a generic "(A4)" is a paper size.
 */
const INTERNAL_REFERENCE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["WI-", /\bWI-[A-Z0-9]/],
  ["ADR-", /\bADR-?\d/],
  // Two or more digits: "#1" is a heading marker, "#12"/"#1081" an issue.
  ["issue-ref", /(?<![\w&])#\d{2,}\b/],
  // ASCII OR full-width parentheses — CJK copy writes "（D4）".
  ["decision-id", /[(（][CDGHRW]\d{1,2}(?:\.\d+)?[)）]/],
  ["OWASP", /\bOWASP\b/],
  ["TODO", /\b(?:TODO|FIXME|TBD|XXX)\b/],
  // Any hyphen, including the non-breaking U+2011, or none.
  ["sign-off", /\bsign[\s\-\u2010\u2011\u2013]?off\b/i],
];

/** A reviewed legitimate match: the exact token that is fine, and why. */
export interface ReferenceException {
  token: string;
  reason: string;
}

/**
 * Reviewed legitimate matches, keyed `<en file>:<key>`. A token alone cannot
 * tell "(C4)" the envelope from "(C4)" the decision id, or "#123" the colour
 * from the issue — this is where the reviewed answer lives. The exemption
 * covers ONLY the approved token (in every locale of that key); anything else
 * in the string is still caught. An entry whose token has left the English
 * value is stale and fails: an exception cannot outlive its reason.
 */
export const INTERNAL_REFERENCE_EXCEPTIONS: Readonly<Record<string, ReferenceException>> = {};

/** Findings in `value` once the approved exception token is removed. */
export function referenceFindingsExcept(value: string, exception: ReferenceException | undefined): string[] {
  return internalReferenceFindings(exception ? value.split(exception.token).join(" ") : value);
}

/** Exception ids whose key is gone or whose token no longer appears in English. */
export function staleReferenceExceptions(
  enValues: Readonly<Record<string, string>>,
  exceptions: Readonly<Record<string, ReferenceException>>,
): string[] {
  return Object.entries(exceptions)
    .filter(([id, e]) => !(id in enValues) || !enValues[id].includes(e.token))
    .map(([id]) => id);
}

/** The internal-reference patterns `value` contains, in pattern order. */
export function internalReferenceFindings(value: string): string[] {
  return INTERNAL_REFERENCE_PATTERNS.filter(([, re]) => re.test(value)).map(([name]) => name);
}
