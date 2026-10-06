/**
 * In-memory disk model behind the Tier-0 stateful fs fake (WI-17).
 *
 * Split out of `statefulFsFake.ts` so each file stays inside the ~300-line
 * gate: this half owns FILES — bytes, directories, mtime, and the operations
 * the `@tauri-apps/plugin-fs` surface delegates to. It knows nothing about
 * Tauri; `statefulFsFake.ts` adapts it to the mocked module surfaces.
 *
 * Two contracts it must keep (see the fake's header for why):
 *   1. Stateful — write→read returns the written bytes; mtime is settable and
 *      observable.
 *   2. No silent success — an operation on a path that does not exist rejects
 *      (async surface) or throws (synchronous test-side reads), never resolves
 *      with `undefined`.
 *
 * @module test/fakeDisk
 */

/** Deterministic epoch for the first modification; no wall clock anywhere. */
const BASE_MTIME_MS = 1_754_000_000_000;
/** How far mtime advances per write when the caller does not pin it. */
const MTIME_STEP_MS = 1_000;

interface FileEntry {
  /** The file's BYTES — what a real disk holds, and what `readFile` returns. */
  bytes: Uint8Array;
  mtimeMs: number;
}

const utf8 = new TextEncoder();
/** Test-side view of a file: every byte, a leading BOM included. */
const exactText = new TextDecoder("utf-8", { ignoreBOM: true });

/** Tauri's `stat` result, narrowed to the fields VMark reads. */
interface FakeFileInfo {
  size: number;
  mtime: Date | null;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Parent directory of a POSIX-ish path (the model is path-string based). */
export function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export function fail(message: string): never {
  throw new Error(`statefulFsFake: ${message}`);
}

/** The in-memory disk: bytes, directories and modification times. */
export class FakeDisk {
  private files = new Map<string, FileEntry>();
  private dirs = new Set<string>(["/"]);
  private clock = BASE_MTIME_MS;

  reset(): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add("/");
    this.clock = BASE_MTIME_MS;
  }

  /** Next deterministic mtime. */
  tick(): number {
    this.clock += MTIME_STEP_MS;
    return this.clock;
  }

  // ── Synchronous, test-side state ──

  /** Put a file on the disk, creating its parent directories. */
  seed(path: string, content: string, opts?: { mtimeMs?: number }): void {
    this.seedBytes(path, utf8.encode(content), opts);
  }

  /** Put raw bytes on the disk — a file no UTF-8 string can describe. */
  seedBytes(path: string, bytes: Uint8Array, opts?: { mtimeMs?: number }): void {
    this.mkdirp(parentOf(path));
    this.files.set(path, { bytes: bytes.slice(), mtimeMs: opts?.mtimeMs ?? this.tick() });
  }

  /**
   * The file at `path` as UTF-8 text, EVERY byte included (a leading BOM is
   * kept, as Node's `readFile(p, "utf8")` keeps it). Throws when absent — an
   * assertion must never read a hole.
   */
  read(path: string): string {
    return exactText.decode(this.entry(path, "read").bytes);
  }

  /** The raw bytes at `path`. Throws when absent. */
  readBytes(path: string): Uint8Array {
    return this.entry(path, "readBytes").bytes.slice();
  }

  private entry(path: string, op: string): FileEntry {
    const entry = this.files.get(path);
    if (!entry) fail(`${op}("${path}") — no such file on the fake disk`);
    return entry;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  hasDir(path: string): boolean {
    return this.dirs.has(path);
  }

  mtimeOf(path: string): number {
    const entry = this.files.get(path);
    if (!entry) fail(`mtimeOf("${path}") — no such file on the fake disk`);
    return entry.mtimeMs;
  }

  setMtime(path: string, mtimeMs: number): void {
    const entry = this.files.get(path);
    if (!entry) fail(`setMtime("${path}") — no such file on the fake disk`);
    entry.mtimeMs = mtimeMs;
  }

  /** Every file path currently on the disk, sorted. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  mkdirp(dir: string): void {
    const parts = dir.split("/");
    let current = "";
    for (const part of parts) {
      current = current === "" ? part || "/" : `${current === "/" ? "" : current}/${part}`;
      this.dirs.add(current);
    }
  }

  /** Byte length (UTF-8), the unit `get_file_size_bytes` reports. */
  byteSize(path: string): number | null {
    const entry = this.files.get(path);
    return entry ? entry.bytes.length : null;
  }

  // ── Async surface (what the mocked plugin delegates to) ──

  /**
   * plugin-fs `readTextFile`, decoded exactly as the plugin decodes it: its
   * Rust command returns the raw bytes and its guest JS runs them through
   * `new TextDecoder("utf-8")`, whose default (`ignoreBOM: false`) DROPS a
   * leading U+FEFF and replaces invalid sequences with U+FFFD. The same
   * constructor reproduces both (see the header of statefulFsFake.ts).
   */
  readTextFile(path: string): Promise<string> {
    return this.readFile(path).then((bytes) => new TextDecoder("utf-8").decode(bytes));
  }

  /** plugin-fs `readFile`: the raw bytes, BOM and all. */
  readFile(path: string): Promise<Uint8Array> {
    const entry = this.files.get(path);
    if (!entry) {
      return Promise.reject(
        new Error(`failed to read file "${path}": No such file or directory (os error 2)`),
      );
    }
    return Promise.resolve(entry.bytes.slice());
  }

  readDir(
    path: string,
  ): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }[]> {
    if (!this.dirs.has(path)) {
      return Promise.reject(new Error(`failed to read dir "${path}": No such file or directory`));
    }
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries = new Map<string, boolean>(); // name → isDirectory
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf("/");
      entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
    }
    return Promise.resolve(
      [...entries].map(([name, isDirectory]) => ({
        name,
        isFile: !isDirectory,
        isDirectory,
        isSymlink: false,
      })),
    );
  }

  /** Does `dir` still contain a file or a subdirectory? */
  private hasChildren(dir: string): boolean {
    // Trailing slash matters: `/repo/data` must not count `/repo/database`.
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) return true;
    }
    for (const other of this.dirs) {
      if (other !== dir && other.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Remove a file or an EMPTY directory.
   *
   * Audit 20260804-F9: this used to delete a non-empty directory and resolve.
   * Real `rmdir` returns ENOTEMPTY, and Tauri's `remove` requires
   * `{ recursive: true }` for that case — a fake that succeeds where the real
   * filesystem fails proves the caller works against a filesystem that does
   * not exist.
   */
  remove(path: string): Promise<void> {
    if (this.files.delete(path)) return Promise.resolve();
    if (this.dirs.has(path)) {
      if (this.hasChildren(path)) {
        return Promise.reject(
          new Error(`failed to remove "${path}": Directory not empty (os error 66)`),
        );
      }
      this.dirs.delete(path);
      return Promise.resolve();
    }
    return Promise.reject(new Error(`failed to remove "${path}": No such file or directory`));
  }

  /**
   * Move a file. The TARGET'S PARENT must exist (audit 20260804-F9): real
   * `rename` returns ENOENT otherwise, and this fake already models exactly
   * that for writes (`performWrite` in statefulFsFake.ts) — the two halves
   * disagreed about whether directories have to exist.
   */
  rename(from: string, to: string): Promise<void> {
    const entry = this.files.get(from);
    if (!entry) {
      return Promise.reject(new Error(`failed to rename "${from}": No such file or directory`));
    }
    const targetDir = parentOf(to);
    if (!this.dirs.has(targetDir)) {
      return Promise.reject(
        new Error(
          `failed to rename "${from}" to "${to}": No such file or directory (os error 2)`,
        ),
      );
    }
    this.files.delete(from);
    this.files.set(to, entry);
    return Promise.resolve();
  }

  stat(path: string): Promise<FakeFileInfo> {
    const entry = this.files.get(path);
    if (!entry) {
      if (this.dirs.has(path)) {
        return Promise.resolve({
          size: 0,
          mtime: null,
          isFile: false,
          isDirectory: true,
          isSymlink: false,
        });
      }
      return Promise.reject(new Error(`failed to stat "${path}": No such file or directory`));
    }
    return Promise.resolve({
      size: entry.bytes.length,
      mtime: new Date(entry.mtimeMs),
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    });
  }
}
