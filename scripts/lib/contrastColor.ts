/**
 * Colour arithmetic for the theme-contrast gate: parse a CSS colour, composite
 * a translucent colour over an opaque one, and the WCAG contrast ratio.
 *
 * @coordinates-with scripts/check-theme-contrast.ts — the gate, which re-exports these
 * @module scripts/lib/contrastColor
 */

export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

/** The CSS colour keywords the theme tokens use. Unquoted keys: the word
 * white is also a theme id, and theme-id strings belong to the catalog
 * (scripts/check-theme-names.sh); here it only names a colour. */
const NAMED_COLORS: Readonly<Record<string, RGBA>> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
};

export function parseColor(raw: string): RGBA {
  const s = raw.trim().toLowerCase();
  if (Object.hasOwn(NAMED_COLORS, s)) return [...NAMED_COLORS[s]];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return [r, g, b, 1];
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`unparseable colour "${raw}"`);
}

export function compositeOver(fg: RGBA, bg: RGBA): RGB {
  const a = fg[3];
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))) as unknown as RGB;
}

function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
