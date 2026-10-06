/**
 * Serve a test's file TEXT as the BYTES plugin-fs `readFile` returns.
 *
 * Documents are read with `readFile` and decoded by
 * `services/files/readDocumentText.ts`, because plugin-fs `readTextFile` drops
 * a leading byte-order mark. A test that mocks plugin-fs therefore models
 * bytes at that boundary. Tests think in text, so this adapter lets a mock
 * keep configuring "the file holds this text" while the mocked `readFile`
 * returns exactly what the real plugin would: its UTF-8 encoding, a leading
 * U+FEFF becoming the EF BB BF mark.
 *
 *     vi.mock("@tauri-apps/plugin-fs", () => ({
 *       readFile: (path: string) => fileBytes(mockFileText(path)),
 *     }));
 *
 * A text mock that yields something other than a string (an unconfigured
 * `vi.fn()` returns `undefined`) rejects with a message saying so, rather than
 * encoding `"undefined"` into a file that never existed.
 *
 * @module test/fileBytes
 */

/** The UTF-8 bytes of `text` (a value or a promise of one), as `readFile` resolves. */
export async function fileBytes(text: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const value: unknown = await text;
  if (typeof value !== "string") {
    throw new Error(
      `fileBytes: the mocked file text is ${String(value)}, not a string — ` +
        `configure the text mock for this read`,
    );
  }
  return new TextEncoder().encode(value);
}
