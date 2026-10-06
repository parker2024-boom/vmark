/**
 * Footnote Types
 *
 * Purpose: The parsed shapes of a markdown footnote reference (`[^label]`)
 * and definition (`[^label]: content`), shared by the parser
 * (footnoteActions.ts) and the renumbering steps (footnoteRenumber.ts)
 * without either importing the other.
 *
 * @module plugins/sourceContextDetection/footnoteTypes
 */

/** A `[^label]` reference outside code; `start`/`end` are document offsets. */
export interface FootnoteRef {
  label: string;
  start: number;
  end: number;
}

/** A `[^label]:` definition, including indented continuation lines. */
export interface FootnoteDef {
  label: string;
  start: number;
  end: number;
  content: string;
}
