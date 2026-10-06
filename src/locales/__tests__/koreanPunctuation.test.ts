// @vitest-environment node
// WI-RA19.7 — Korean ends a sentence with "." (U+002E), not the ideographic
// full stop "。" (U+3002) that Chinese and Japanese use. Seven Korean toast
// strings ended with "。", a slip from translating beside the CJK locales.
// A Korean value may still SHOW "。" as an example (the CJK punctuation
// settings do); what it may not do is use it to end Korean text.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const koDir = join(root, "src/locales/ko");

/** "。" or "，" closing Korean text: right after a Hangul syllable, or last in the value. */
const IDEOGRAPHIC_AFTER_HANGUL = /[가-힣][)"”’']?[。，]/u;
const ENDS_IDEOGRAPHIC = /[。，]\s*$/u;

function offenders(entries: Iterable<[string, string]>): string[] {
  const bad: string[] = [];
  for (const [key, value] of entries) {
    if (IDEOGRAPHIC_AFTER_HANGUL.test(value) || ENDS_IDEOGRAPHIC.test(value)) bad.push(`${key}: ${value}`);
  }
  return bad;
}

describe("Korean punctuation", () => {
  const files = readdirSync(koDir).filter((f) => f.endsWith(".json"));

  it("finds the Korean bundles", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s ends no Korean text with an ideographic stop or comma", (file) => {
    const bundle = JSON.parse(readFileSync(join(koDir, file), "utf8")) as Record<string, string>;
    expect(offenders(Object.entries(bundle))).toEqual([]);
  });

  it("the Rust Korean bundle ends no Korean text with an ideographic stop or comma", () => {
    const lines = readFileSync(join(root, "src-tauri/locales/ko.yml"), "utf8").split("\n");
    expect(lines.length).toBeGreaterThan(10);
    expect(offenders(lines.map((line, i): [string, string] => [`line ${i + 1}`, line.replace(/["']\s*$/, "")]))).toEqual([]);
  });

  it("still allows the punctuation to be shown as an example", () => {
    expect(offenders([["example", "반복되는 ！？。 제한"]])).toEqual([]);
    expect(offenders([["slip", "드롭이 차단되었습니다。"]])).toHaveLength(1);
  });
});
