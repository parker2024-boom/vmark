/**
 * Purpose: a faithful port of tauri 2's path `normalize` for a "/"-separated
 * platform, so containment tests run against the separators and edge cases
 * the real command produces rather than a convenient approximation.
 *
 * Ported line for line from tauri's `crates/tauri/src/path/plugin.rs`
 * (`normalize_path_no_absolute` + `normalize`); the port was compiled and run
 * against std::path to confirm "/" → "//" and "//etc/passwd" → "/etc/passwd".
 * Two consequences the export containment code must handle:
 *   - an input ending in a separator keeps one, so a ROOT comes back as "//";
 *   - a leading "//" in any other path collapses to "/".
 *
 * On Windows the same code keeps the drive prefix and also re-appends the
 * trailing separator, so a drive root "D:\\" comes back as "D:\\\\".
 */

/** tauri 2 `normalize`, ported (POSIX separator). */
export function tauriNormalize(path: string): string {
  let ret = path.startsWith("/") ? "/" : "";
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // PathBuf::pop: drop the last component; a bare root stays a root.
      const cut = ret.lastIndexOf("/");
      ret = ret === "/" ? "/" : cut > 0 ? ret.slice(0, cut) : ret.startsWith("/") ? "/" : "";
      continue;
    }
    if (ret !== "" && !ret.endsWith("/")) ret += "/";
    ret += part;
  }
  if (ret === "" && path === "..") return "..";
  if (ret === "" && (path === "" || path === ".")) return ".";
  // The upstream condition is always true for an input ending in a separator.
  if (path.endsWith("/")) ret += "/";
  return ret;
}

/**
 * tauri 2 `join` for an absolute base and RELATIVE parts: concatenate, then
 * normalize. (The real command lets an absolute later part replace the base;
 * no caller under test joins one.)
 */
export function tauriJoin(...parts: string[]): string {
  return tauriNormalize(parts.join("/"));
}

/** tauri 2 `dirname` for the absolute POSIX paths these tests use. */
export function tauriDirname(path: string): string {
  return path.split("/").slice(0, -1).join("/") || "/";
}
