/**
 * Strict parsing/validation of `vmark.browser.style` operation arguments —
 * split from browserPower.ts (file-size rule). Everything invalid returns an
 * error string; a partially valid operation is never silently trimmed.
 *
 * @coordinates-with browserPower.ts — sole consumer
 * @module services/mcpBridge/v2/browserStyleOps
 */
import type { StyleOps } from "@/lib/browser/agent/powerScript";
import type { CheckedOperationArgs } from "./readOperationArgs";

/**
 * Strict parse of the style operations. Returns an error string for anything
 * invalid — a non-string `set` value, an empty/whitespace class token (those
 * throw inside `classList` mid-mutation), or `injectCss` combined with
 * element ops (the generated script would silently skip the element ops).
 * A field of the wrong shape is refused by name, never read as absent: that
 * would apply the rest of a request the caller did not send.
 */
export function readStyleOps({
  wire,
  malformed,
}: CheckedOperationArgs<"vmark.browser.style">): { ops: StyleOps } | { error: string } {
  const ops: StyleOps = {};
  if (malformed.has("set")) return { error: "style 'set' must be an object" };
  if (wire.set !== undefined) {
    ops.set = {};
    for (const [k, v] of Object.entries(wire.set as Record<string, unknown>)) {
      if (typeof v !== "string") return { error: `style set['${k}'] must be a string` };
      ops.set[k] = v;
    }
  }
  const readClassList = (key: "addClasses" | "removeClasses"): string | null => {
    if (malformed.has(key)) return `style '${key}' must be an array of class names`;
    const entries: unknown[] | undefined = wire[key];
    if (entries === undefined) return null;
    const list: string[] = [];
    for (const c of entries) {
      if (typeof c !== "string" || !c.trim() || /\s/.test(c)) {
        return `style '${key}' entries must be non-empty single class tokens`;
      }
      list.push(c);
    }
    ops[key] = list;
    return null;
  };
  const addErr = readClassList("addClasses");
  if (addErr) return { error: addErr };
  const removeErr = readClassList("removeClasses");
  if (removeErr) return { error: removeErr };
  if (malformed.has("injectCss")) return { error: "style 'injectCss' must be a string" };
  if (wire.injectCss !== undefined && wire.injectCss.length > 0) ops.injectCss = wire.injectCss;

  const hasElementOps =
    (ops.set && Object.keys(ops.set).length > 0) || ops.addClasses?.length || ops.removeClasses?.length;
  if (ops.injectCss && hasElementOps) {
    return { error: "style 'injectCss' cannot be combined with set/addClasses/removeClasses" };
  }
  if (!hasElementOps && !ops.injectCss) {
    return { error: "style requires one of: set, addClasses, removeClasses, or injectCss" };
  }
  return { ops };
}

