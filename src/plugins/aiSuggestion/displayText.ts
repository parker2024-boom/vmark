/**
 * Purpose: the text an AI suggestion's ghost preview shows — the suggested
 * markdown with the serializer's backslash escapes removed and autolinks
 * collapsed, so the preview reads as the text the user will see after
 * accepting it.
 *
 * Key decisions:
 *   - For DISPLAY only, never for markdown that is pasted, copied or saved:
 *     the escapes removed here are the ones that keep text meaning what it
 *     says (`\#`, `1\.`, `\|`), and the stripping does not spare code.
 *
 * @coordinates-with plugins/aiSuggestion/widgets.ts — renders the ghost text
 * @module plugins/aiSuggestion/displayText
 */

/**
 * Strip markdown escapes and collapse autolinks, for display.
 *
 * Collapses autolink expansions:
 *   [https://example.com](https://example.com) → https://example.com
 *   [user@host.com](mailto:user@host.com)      → user@host.com
 */
export function suggestionDisplayText(md: string): string {
  let result = md;

  // 1. Strip backslash escapes added by remark-stringify for round-trip safety.
  //    Only strip known serializer-added escapes (punctuation), not arbitrary chars.
  //    Must run before autolink collapsing because link text has escapes
  //    (e.g. user\@host) but the URL does not — back-reference won't match
  //    unless we clean escapes first.
  result = result.replace(/\\([#\-*_`|[\]()>+.!~$@&:\\])/g, "$1");

  // 2. Collapse redundant autolinks where text equals URL
  result = result.replace(/\[([^\]]+)\]\((?:mailto:)?\1\)/g, "$1");

  return result;
}
