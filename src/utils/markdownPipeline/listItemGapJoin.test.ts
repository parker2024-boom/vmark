// @vitest-environment node
// WI-RA26.2 — the join that writes a loose list's item gaps as the author did.
//
// CommonMark makes a whole list loose when ANY two of its items are separated
// by a blank line, so `1. a\n2. b\n\n3. c` is one loose list. The serializer's
// default join writes a loose list with a blank line between EVERY pair of
// items, which rewrote the author's file on save. The join keeps the gaps the
// source did not have, and only while the list stays loose without them.
import { describe, expect, it } from "vitest";
import type { List, ListItem, Paragraph } from "mdast";
import { listItemGapJoin } from "./listItemGapJoin";

const para = (value: string): Paragraph => ({ type: "paragraph", children: [{ type: "text", value }] });
const item = (value: string, tightBefore = false, spread = false): ListItem => ({
  type: "listItem",
  spread,
  children: [para(value)],
  ...(tightBefore ? { data: { tightBefore: true } } : {}),
});
const list = (spread: boolean, ...children: ListItem[]): List => ({
  type: "list",
  ordered: false,
  spread,
  children,
});

describe("listItemGapJoin", () => {
  it("writes no blank line before an item the author wrote directly under the previous one", () => {
    const parent = list(true, item("a"), item("b", true), item("c"));
    expect(listItemGapJoin(parent.children[0], parent.children[1], parent)).toBe(0);
  });

  it("defers (the list's own blank line) before an item that had one", () => {
    const parent = list(true, item("a"), item("b", true), item("c"));
    expect(listItemGapJoin(parent.children[1], parent.children[2], parent)).toBeUndefined();
  });

  it("defers in a tight list, whose items are never separated", () => {
    const parent = list(false, item("a"), item("b", true));
    expect(listItemGapJoin(parent.children[0], parent.children[1], parent)).toBeUndefined();
  });

  it("defers when every gap is marked tight and no item is spread: the list would read back tight", () => {
    // An edit removed the only item that carried the blank line. Writing the
    // remaining gaps tight would turn a loose list into a tight one.
    const parent = list(true, item("a"), item("b", true), item("c", true));
    expect(listItemGapJoin(parent.children[0], parent.children[1], parent)).toBeUndefined();
    expect(listItemGapJoin(parent.children[1], parent.children[2], parent)).toBeUndefined();
  });

  it("keeps the gaps tight when a spread item keeps the list loose", () => {
    // `- a\n- b\n\n  more\n- c`: loose because item b holds two blocks with a
    // blank line between them; no gap between items needs one.
    const b: ListItem = { ...item("b", true, true), children: [para("b"), para("more")] };
    const parent = list(true, item("a"), b, item("c", true));
    expect(listItemGapJoin(parent.children[0], b, parent)).toBe(0);
    expect(listItemGapJoin(b, parent.children[2], parent)).toBe(0);
  });

  it("ignores a marker on the first item, which has no gap before it", () => {
    const parent = list(true, item("a", true), item("b"));
    expect(listItemGapJoin(parent.children[0], parent.children[1], parent)).toBeUndefined();
  });

  it("says nothing about pairs that are not two items of a list", () => {
    const parent = list(true, item("a"), item("b", true), item("c"));
    expect(listItemGapJoin(para("x"), parent, { type: "root", children: [] })).toBeUndefined();
    expect(listItemGapJoin(para("x"), para("y"), parent.children[0])).toBeUndefined();
  });

  it("only a literal true marks a gap tight", () => {
    const loose: ListItem = { ...item("b"), data: { tightBefore: "yes" as unknown as boolean } };
    const parent = list(true, item("a"), loose, item("c"));
    expect(listItemGapJoin(parent.children[0], loose, parent)).toBeUndefined();
  });
});
