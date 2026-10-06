/**
 * The one way a document's text comes off disk.
 *
 * Purpose: plugin-fs `readTextFile` cannot read a document. Its Rust side
 * returns the file's bytes and its guest JS decodes them with
 * `new TextDecoder("utf-8")`, whose default (`ignoreBOM: false`) drops a
 * leading byte-order mark. A file starting with EF BB BF therefore reached the
 * app without the U+FEFF that `ingestExternalText` records as `hasBom`, and the
 * first save wrote it back without its BOM. Comparisons against disk need the
 * mark too — the own-save echo filter, external-change detection, the
 * watcher's fingerprint — or a file that gained or lost one reads as unchanged.
 *
 * This module reads the BYTES and decodes them itself, keeping a leading BOM
 * as U+FEFF: the raw disk text the document store's ingest boundary expects.
 *
 * Key decisions:
 *   - It returns a string, not `{ text, hasBom }`. BOM detection already has
 *     one home (`ingestExternalText`), and every consumer — the store's
 *     ingest, `lastDiskContent`, `matchesPendingSave` — works in raw disk text,
 *     which is exactly what the save path writes back. A second `hasBom`
 *     channel would be a second source of truth for the same byte.
 *   - UTF-16 and UTF-32 files, identified by their BOM, are REFUSED with
 *     `UnsupportedEncodingError`. Decoded as UTF-8 they are U+FFFD and NULs on
 *     screen, and a save would overwrite the file with that. VMark writes
 *     UTF-8 only, so it cannot round-trip them; the error message names the
 *     file and the encoding and becomes the open-failure toast's detail.
 *   - The UTF-32LE mark (FF FE 00 00) is tested before UTF-16LE (FF FE), which
 *     it begins with. A UTF-16LE file whose first character is U+0000 is
 *     labelled UTF-32LE; both are refused, so only the label differs.
 *
 * Known limitations:
 *   - Invalid UTF-8 without a BOM (a Latin-1 or GBK file) still decodes lossily
 *     to U+FFFD, exactly as `readTextFile` did; refusing or transcoding such
 *     files is a product decision this reader does not make.
 *
 * @coordinates-with utils/editorText.ts — ingestExternalText turns the U+FEFF into hasBom
 * @coordinates-with services/persistence/saveToPath.ts — normalizeSaveContent re-emits it
 * @coordinates-with services/files/documentReadInvariant.test.ts — no document read bypasses this
 * @module services/files/readDocumentText
 */
import { readFile } from "@tauri-apps/plugin-fs";

/** Text encodings VMark recognises by their BOM and cannot round-trip. */
export type UnsupportedEncoding = "UTF-16LE" | "UTF-16BE" | "UTF-32LE" | "UTF-32BE";

/** Byte-order marks of the refused encodings, longest first (see key decisions). */
const REFUSED_MARKS: readonly { encoding: UnsupportedEncoding; mark: readonly number[] }[] = [
  { encoding: "UTF-32LE", mark: [0xff, 0xfe, 0x00, 0x00] },
  { encoding: "UTF-32BE", mark: [0x00, 0x00, 0xfe, 0xff] },
  { encoding: "UTF-16LE", mark: [0xff, 0xfe] },
  { encoding: "UTF-16BE", mark: [0xfe, 0xff] },
];

/** A document whose bytes VMark will not decode as UTF-8. */
export class UnsupportedEncodingError extends Error {
  readonly path: string;
  readonly encoding: UnsupportedEncoding;

  /** The message is for logs; the UI translates from `path` and `encoding`. */
  constructor(path: string, encoding: UnsupportedEncoding, mark: readonly number[]) {
    const hex = mark.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    super(`${path}: ${encoding} text (byte-order mark ${hex}); VMark reads and writes UTF-8 only`);
    this.name = "UnsupportedEncodingError";
    this.path = path;
    this.encoding = encoding;
  }
}

function startsWith(bytes: Uint8Array, mark: readonly number[]): boolean {
  return bytes.length >= mark.length && mark.every((b, i) => bytes[i] === b);
}

/**
 * Decode a document's bytes as UTF-8, keeping a leading BOM as U+FEFF.
 *
 * @throws UnsupportedEncodingError for a UTF-16 or UTF-32 byte-order mark.
 */
export function decodeDocumentBytes(bytes: Uint8Array, path: string): string {
  const refused = REFUSED_MARKS.find(({ mark }) => startsWith(bytes, mark));
  if (refused) throw new UnsupportedEncodingError(path, refused.encoding, refused.mark);
  // `ignoreBOM: true` is the whole fix: the decoder hands the mark through
  // instead of consuming it. Not `fatal` — see Known limitations.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Read a document's text exactly as it is on disk, a leading BOM included.
 *
 * @throws UnsupportedEncodingError for a UTF-16 or UTF-32 file; otherwise
 *   whatever plugin-fs `readFile` throws (missing file, permission denied).
 */
export async function readDocumentText(path: string): Promise<string> {
  return decodeDocumentBytes(await readFile(path), path);
}
