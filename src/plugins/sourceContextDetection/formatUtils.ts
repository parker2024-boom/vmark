/**
 * Source format helpers — test, add and strip a prefix/suffix wrapper around
 * text, and name subscript and superscript as each other's opposite.
 *
 * @module plugins/sourceContextDetection/formatUtils
 */

import type { FormatType, WrapFormatType } from "./formatTypes";

export function isWrapped(text: string, prefix: string, suffix: string): boolean {
  return text.startsWith(prefix) && text.endsWith(suffix);
}

export function unwrap(text: string, prefix: string, suffix: string): string {
  return text.slice(prefix.length, text.length - suffix.length);
}

export function wrap(text: string, prefix: string, suffix: string): string {
  return `${prefix}${text}${suffix}`;
}

export function getOppositeFormat(format: FormatType): WrapFormatType | null {
  if (format === "subscript") return "superscript";
  if (format === "superscript") return "subscript";
  return null;
}
