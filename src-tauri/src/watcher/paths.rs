//! # Watcher path rules
//!
//! Purpose: Decides which reported paths the owning window hears about, and
//! how they are spelled: noise is dropped, and a path the OS reports under the
//! resolved root is rebased onto the root the caller asked to watch.
//!
//! Known limitations:
//!   - No recursive ignore patterns — filtering is component-based, not glob-based.
//!
//! @coordinates-with watcher.rs — applies both rules to every notify event
//! @module watcher/paths

use std::path::Path;

/// Directory/file names that should always be ignored by the file watcher.
/// Only list specific high-frequency noise sources — do NOT blanket-ignore
/// all dot-directories, since user-visible ones like `.github/`, `.vscode/`,
/// `.husky/` need external change detection.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".obsidian",
    ".svn",
    ".hg",
    "node_modules",
    ".DS_Store",
    ".Trash",
    "__pycache__",
];

/// Check whether a filesystem path should be ignored by the watcher.
///
/// Returns true if any path component matches the explicit ignore list,
/// or if the filename matches temp file patterns from atomic writes.
/// User-visible dot-directories (`.github`, `.vscode`, etc.) are allowed
/// through so that external changes to those files are detected.
pub(super) fn should_ignore_path(path: &Path) -> bool {
    // Filter temp files created by atomic writes to reduce event noise.
    // NamedTempFile (lib.rs): dot-prefixed names like ".tmpXXXXXX" (6+ random chars)
    // app_paths.rs: names like ".{name}.tmp.{pid}" (contains ".tmp." infix)
    // We require the name to start with a dot to avoid filtering user files.
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('.') && (name.starts_with(".tmp") || name.contains(".tmp.")) {
            return true;
        }
    }

    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name_str = name.to_string_lossy();
            if IGNORED_DIRS.contains(&name_str.as_ref()) {
                return true;
            }
        }
    }
    false
}

/// Spell a path the watcher reported under the root the caller asked to watch.
///
/// The OS reports the REAL path (`/private/var/…` for a root given as
/// `/var/…`, the target for a root reached through any symlink), while the
/// window's scope filter compares against the root string it started the watch
/// with. Every event under a symlinked root therefore fell out of scope, the
/// explorer never refreshed on fs events there, and only the window-focus refresh
/// masked it (found by #1357's live check, whose workspace lived under macOS's
/// `/var` → `/private/var` link). `canonical_root` is the resolved root; a
/// reported path under it is rebased onto `root`; anything else is returned as
/// it came. The prefix must end at a path separator so `/root2/x` never matches
/// `/root`.
pub(super) fn rebase_onto_root(path: &str, root: &str, canonical_root: &str) -> String {
    if canonical_root == root || !path.starts_with(canonical_root) {
        return path.to_string();
    }
    let rest = &path[canonical_root.len()..];
    if rest.is_empty() {
        return root.to_string();
    }
    if !rest.starts_with(std::path::MAIN_SEPARATOR) && !rest.starts_with('/') {
        return path.to_string();
    }
    format!("{root}{rest}")
}
