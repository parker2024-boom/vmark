/**
 * The definition grammar behind `scripts/check-deleted-names.mjs`: for one
 * tombstoned name, the `git grep -E` patterns (POSIX ERE) that find it being
 * DEFINED again — TypeScript/JavaScript exports, Rust items, and the wrapped
 * export clause a line-based scan cannot see — plus the multiline JS RegExp
 * that confirms a wrapped-clause candidate.
 *
 * Purpose: keep what counts as "the name is back" in one place, separate from
 * how the gate runs git, reads the registry and reports.
 *
 * SYMBOL DETECTION covers the export forms the codebase actually uses (see
 * `symbolPatterns`): plain and `async` functions, generators, `const`/`let`/
 * `var`, classes (incl. `abstract`), `type`/`interface`/`enum`, `declare`
 * variants, `export default`, `export { X as Name }` re-exports and
 * `export * as Name from …`. The first version matched only
 * `export (function|const|class|type|interface) Name`, so a deleted symbol
 * could come back as `export async function`, or be re-exported from a new
 * file under its old name, without the gate noticing.
 *
 * RUST ITEMS are covered too:`[pub[(crate|super|self|in path)]]
 * [const] [async] [unsafe] [extern ["ABI"]] (fn|struct|enum|type|const|static|
 * mod|trait|union) [r#]Name`, with any whitespace the grammar allows inside
 * `pub ( crate )` / `pub(in  path )` and a raw identifier (`fn r#name`) treated
 * as the name it spells. Before that, a Rust name registered here was a
 * tombstone nothing could trip over — the grammar knew only `export`, so the
 * entry was green with no coverage at all. A CALL or a `use` of the name is
 * not a definition and does not fire. This is the SUPPORTED grammar, fixture-
 * tested form by form — not a Rust parser: an item produced by a macro, or
 * one whose keyword and name sit on different lines, is outside it.
 *
 * A WRAPPED export clause (`export {\n  useX,\n} from "./x"`) is the one form a
 * line-based scan structurally cannot see, and prettier produces it for any
 * clause past the print width — so it is the ordinary shape of a barrel file.
 * It is covered by a two-stage check (`wrappedExportClausePattern`): git grep
 * finds files with a lone-identifier line, then each candidate is READ and
 * confirmed with a multiline `export { … }` match, so an import clause does
 * not fire. The header used to record this as a limitation left open on the
 * grounds that the registry was "eight entries long"; it is now a dozen symbol
 * tombstones and the premise expired.
 *
 * @coordinates-with scripts/check-deleted-names.mjs — the gate that greps with these patterns
 * @coordinates-with scripts/check-deleted-names.test.mjs — fixture-tests each form
 * @module scripts/lib/deletedNamePatterns
 */

/** POSIX ERE word boundary — `git grep -E` has no portable `\b`. */
const EDGE = "[^A-Za-z0-9_$]";
const SP = "[[:space:]]";

/**
 * `name` as a LITERAL inside a POSIX ERE. `$` is legal in a TypeScript
 * identifier (`use$Store`); interpolated raw it reads as end-of-line, so the
 * pattern could never match and the tombstone was silently dead — a tripwire
 * failing open. Only ERE's own specials are escaped: `}` and `]` are ordinary
 * outside their constructs, and escaping them is undefined in POSIX.
 */
function ereEscape(name) {
  return name.replace(/[.*+?^$(){|[\\]/g, "\\$&");
}

/** Every export form that would re-introduce `name`, as `git grep -E` patterns. */
export function symbolPatterns(name) {
  const declarators = "function|const|let|var|class|type|interface|enum|namespace|module";
  const id = ereEscape(name);
  // Qualifiers that may sit between `export` and the declarator, in any order
  // the language allows: `export const enum X`, `export declare abstract class
  // X`, `export async function* x`. Written as a repeated alternation rather
  // than a fixed chain — the chain missed `const enum` outright.
  const quals = `((default|declare|async|abstract|const)${SP}+)*`;
  // `export type { X }` / `export type * as X from …` are the type-only
  // spellings, and the brace pattern anchored on `export` + `{` did not reach
  // past the `type` keyword — the commonest re-export form in this codebase.
  const clause = `(type${SP}+)?`;
  return [
    // export [default] [declare] [async] [abstract] [const] <declarator>[*] Name
    `export${SP}+${quals}(${declarators})[[:space:]*]+${id}(${EDGE}|$)`,
    // export default Name        — re-export of an existing binding
    `export${SP}+default${SP}+${id}(${EDGE}|$)`,
    // export import Name = require(…) / = A.B  (TypeScript import alias)
    `export${SP}+import${SP}+${id}${SP}*=`,
    // export [type] { Name }, export { X as Name }, export { a, Name } [from "…"]
    `export${SP}*${clause}\\{${SP}*${id}(${EDGE}|$)`,
    `export${SP}*${clause}\\{[^}]*${EDGE}${id}(${EDGE}|$)`,
    // export [type] * as Name from "…"
    `export${SP}*${clause}[*]${SP}+as${SP}+${id}(${EDGE}|$)`,
  ];
}

/**
 * A WRAPPED export clause names `name` — the one form `git grep` structurally
 * cannot see, because the clause spans lines:
 *
 *     export {
 *       useX,
 *     } from "./x";
 *
 * Prettier wraps any clause past the print width, so this is the ordinary
 * shape of a barrel file, not an exotic one. Two stages, so no file is read
 * that does not have to be: `git grep` finds files carrying a line that is
 * just the identifier (with an optional trailing comma or `as` alias), then
 * each candidate is READ and confirmed with a multiline match, so an import
 * clause or an array element does not fire.
 *
 * The header used to record this as a limitation deliberately left open "for a
 * coarse tripwire whose registry is eight entries long". The registry now
 * carries a dozen symbol tombstones, so the premise expired.
 */
export function wrappedExportClausePattern(name) {
  const id = ereEscape(name);
  // Either side of an alias: the wrapped line may be `usePopupStore,` or
  // `theStore as usePopupStore,` — the single-line patterns fire on both, so
  // the wrapped probe must too.
  const ident = "[A-Za-z0-9_$]+";
  return `^${SP}*(${ident}${SP}+as${SP}+)?${id}(${SP}+as${SP}+${ident})?${SP}*,?${SP}*$`;
}

/** `name` as a literal inside a JS RegExp (distinct from `ereEscape`'s POSIX set). */
const jsEscape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A real `export [type] { … <name> … }` clause, however many lines it spans. */
export const clauseRe = (name) =>
  new RegExp(
    String.raw`export\s+(?:type\s+)?\{[^}]*(?:^|[^A-Za-z0-9_$])` +
      jsEscape(name) +
      String.raw`(?![A-Za-z0-9_$])[^}]*\}`,
    "m",
  );

/**
 * Every Rust item form that would re-introduce `name`. Scanned over `.rs`
 * files ONLY: `const name = 1;` is a private local in TypeScript, and the
 * TypeScript grammar above deliberately does not fire on those.
 */
export function rustSymbolPatterns(name) {
  const items = "fn|struct|enum|type|const|static|mod|trait|union";
  // Visibility: `pub`, `pub(crate|super|self)`, `pub(in some::path)` — with
  // whitespace allowed wherever the grammar allows it (`pub ( crate )`).
  const vis = `(pub(${SP}*\\(${SP}*(crate|super|self|in${SP}+[^)]+)${SP}*\\))?${SP}+)?`;
  // Function qualifiers, any combination and order the grammar allows:
  // `const`, `async`, `unsafe`, `extern` with or without an ABI string.
  // `const` doubles as an item keyword (`pub const NAME: u8`); the alternation
  // backtracks, so both readings are tried.
  const quals = `((const|async|unsafe|extern(${SP}+"[^"]*")?)${SP}+)*`;
  // A raw identifier names the same item: `fn r#name` IS `name` coming back.
  return [`^${SP}*${vis}${quals}(${items})${SP}+(r#)?${ereEscape(name)}(${EDGE}|$)`];
}
