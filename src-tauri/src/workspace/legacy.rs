//! # Workspace config — legacy layouts
//!
//! Purpose: everything that reads or retires an OLD on-disk form of a
//! workspace config: the 8-byte hash filename used by releases <= 0.7.22, the
//! `.vmark/vmark.code-workspace` directory format and the ancient plain
//! `.vmark` file. Split out of `workspace/mod.rs` so the commands there stay small.
//!
//! Sunset: the `.vmark` half (`clean_excludes`, `migrate_from_legacy`,
//! `cleanup_old_vmark`) goes once no supported upgrade path starts below
//! 0.4.18 (the last release that wrote that layout was 0.4.17); the hash half
//! once none starts below 0.7.23.
//!
//! @coordinates-with mod.rs — `read_workspace_config` migrates through these
//! @module workspace/legacy

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{WorkspaceConfig, WorkspaceIdentity};

/// Outcome of a hash-filename migration. `RenameFailed` is load-bearing: the caller
/// must fall back to the legacy file rather than treat it as absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HashMigrationOutcome {
    /// New-layout file already exists; nothing to do.
    AlreadyMigrated,
    /// No legacy file present; nothing to do.
    NoLegacyFile,
    /// Renamed legacy → new successfully.
    Renamed,
    /// Tried to rename but the syscall failed; legacy file left in place.
    RenameFailed,
}

/// Pure-paths migration helper: if `legacy_path` exists and `new_path` does
/// not, rename one to the other. Split out from `migrate_legacy_hash_filename`
/// so unit tests can exercise every branch without a Tauri AppHandle.
pub(super) fn try_rename_legacy_hash(
    legacy_path: &std::path::Path,
    new_path: &std::path::Path,
) -> HashMigrationOutcome {
    if new_path.exists() {
        return HashMigrationOutcome::AlreadyMigrated;
    }
    if !legacy_path.exists() {
        return HashMigrationOutcome::NoLegacyFile;
    }
    // Not synced: a crash that undoes this rename leaves the legacy file where
    // it was, and the next read migrates it again.
    match fs::rename(legacy_path, new_path) {
        Ok(()) => {
            log::info!(
                "[workspace] migrated config to 16-byte hash: {:?} -> {:?}",
                legacy_path,
                new_path
            );
            HashMigrationOutcome::Renamed
        }
        Err(e) => {
            log::warn!(
                "[workspace] failed to migrate legacy config {:?}: {}",
                legacy_path,
                e
            );
            HashMigrationOutcome::RenameFailed
        }
    }
}

/// Migrate the legacy-hash file to `new_path`, and hand back the legacy path ONLY when
/// the rename failed and the file is therefore still sitting there. The caller MUST read
/// from it: treating a failed rename as "no config" returns `None`, and the next write
/// then buries the user's excludes, tabs and identity/trust grant under a fresh default.
///
/// AppHandle-free so the fallback decision itself is unit-testable.
pub(super) fn fallback_after_rename(legacy: PathBuf, new_path: &Path) -> Option<PathBuf> {
    match try_rename_legacy_hash(&legacy, new_path) {
        HashMigrationOutcome::RenameFailed => Some(legacy),
        _ => None,
    }
}

// ============================================================================
// Legacy migration types (kept private)
// ============================================================================

/// VS Code-compatible workspace file — legacy `.vmark/vmark.code-workspace`.
#[derive(Debug, Deserialize)]
struct LegacyWorkspaceFile {
    #[serde(default)]
    settings: LegacyWorkspaceSettings,
}

#[derive(Debug, Deserialize, Default)]
struct LegacyWorkspaceSettings {
    #[serde(rename = "vmark.excludeFolders", default)]
    exclude_folders: Vec<String>,
    #[serde(rename = "vmark.showHiddenFiles", default)]
    show_hidden_files: bool,
    #[serde(rename = "vmark.lastOpenTabs", default)]
    last_open_tabs: Vec<String>,
    #[serde(rename = "vmark.ai", default)]
    ai: Option<serde_json::Value>,
    #[serde(rename = "vmark.identity", default)]
    identity: Option<WorkspaceIdentity>,
}

/// Ancient legacy workspace configuration (plain `.vmark` file).
#[derive(Debug, Deserialize)]
struct AncientLegacyConfig {
    #[serde(default)]
    version: u32,
    #[serde(rename = "excludeFolders", default)]
    exclude_folders: Vec<String>,
    #[serde(rename = "lastOpenTabs", default)]
    last_open_tabs: Vec<String>,
    #[serde(default)]
    ai: Option<serde_json::Value>,
}

// ============================================================================
// Legacy migration
// ============================================================================

/// Strip `.vmark` from a legacy exclude list — the directory no longer exists.
pub(super) fn clean_excludes(folders: Vec<String>) -> Vec<String> {
    folders.into_iter().filter(|f| f != ".vmark").collect()
}

/// Try to read config from legacy `.vmark/` directory or ancient `.vmark` file.
/// Returns `Ok(Some(config))` if found, `Ok(None)` if no legacy exists. Both branches
/// spread `WorkspaceConfig::default()` and name only the fields the legacy format
/// carried, so a field added later cannot be migrated inconsistently between them.
pub(super) fn migrate_from_legacy(root_path: &str) -> Result<Option<WorkspaceConfig>, String> {
    let root = Path::new(root_path);
    let dot_vmark = root.join(".vmark");

    // 1. Try .vmark/vmark.code-workspace (directory format)
    if dot_vmark.is_dir() {
        let ws_file_path = dot_vmark.join("vmark.code-workspace");
        if ws_file_path.exists() {
            let content = fs::read_to_string(&ws_file_path)
                .map_err(|e| format!("Failed to read legacy workspace file: {e}"))?;
            let ws: LegacyWorkspaceFile = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse legacy workspace file: {e}"))?;

            return Ok(Some(WorkspaceConfig {
                exclude_folders: clean_excludes(ws.settings.exclude_folders),
                show_hidden_files: ws.settings.show_hidden_files,
                last_open_tabs: ws.settings.last_open_tabs,
                ai: ws.settings.ai,
                identity: ws.settings.identity,
                ..WorkspaceConfig::default()
            }));
        }
    }

    // 2. Try .vmark as a plain file (ancient format)
    if dot_vmark.is_file() {
        let content = fs::read_to_string(&dot_vmark)
            .map_err(|e| format!("Failed to read ancient .vmark: {e}"))?;
        let ancient: AncientLegacyConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse ancient .vmark: {e}"))?;

        return Ok(Some(WorkspaceConfig {
            // A file predating the `version` key deserializes to 0 — a schema version
            // we never emitted. Clamp to the v1 it is, rather than persisting 0.
            version: ancient.version.max(1),
            exclude_folders: clean_excludes(ancient.exclude_folders),
            last_open_tabs: ancient.last_open_tabs,
            ai: ancient.ai,
            ..WorkspaceConfig::default()
        }));
    }

    Ok(None)
}

/// Best-effort cleanup of legacy `.vmark/` in a workspace root.
/// Removes workspace file, then tries to remove the directory (only if empty).
pub(super) fn cleanup_old_vmark(root_path: &str) {
    let root = Path::new(root_path);
    let dot_vmark = root.join(".vmark");

    if dot_vmark.is_dir() {
        // Remove known file
        let _ = fs::remove_file(dot_vmark.join("vmark.code-workspace"));
        // Try rmdir (fails if not empty — that's fine)
        let _ = fs::remove_dir(&dot_vmark);
    } else if dot_vmark.is_file() {
        let _ = fs::remove_file(&dot_vmark);
    }
}
