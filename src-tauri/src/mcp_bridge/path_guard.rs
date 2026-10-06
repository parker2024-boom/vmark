//! MCP bridge path guard.
//!
//! The frontend first applies the pure string policy, then calls this command
//! before bridge file reads/writes. This command resolves symlinks for existing
//! targets and for the deepest existing ancestor of new targets, closing the
//! classic `workspace/link -> /etc` escape.
//!
//! Cross-layer contract: the `mcp_bridge_check_path` parameter names
//! (`file_path`, `allowed_roots`) are bound by Tauri's camelCase→snake_case
//! convention to the JS invoke args (`filePath`, `allowedRoots`) sent from
//! `services/mcpBridge/bridgePathGuard.ts`. Renaming a parameter on EITHER side
//! silently breaks the bridge (the arg fails to bind at runtime) — no compiler
//! or unit test catches it. The JS side of the contract is pinned in
//! `bridgePathGuard.test.ts`; keep the names here in lockstep.
//!
//! Rejections are typed `CommandError`s: a malformed path or root is
//! `invalid-input`, a path outside every allowed root (or no root at all) is
//! `permission-denied`, and a resolution failure keeps the class the OS
//! reported. The messages are the agent-facing English the JS policy uses for
//! the same refusals; the frontend relays `message`.
//!
//! Known limitation (TOCTOU): this check and the subsequent `writeTextFile` /
//! `readTextFile` are two separate frontend calls, not one atomic operation. A
//! symlink swapped into an allowed root between the check and the write could
//! escape the canonical-path resolution. Accepted for a local single-user
//! editor; revisit if bridge fs ever runs against an untrusted live workspace.

use std::path::{Component, Path, PathBuf};

use crate::command_error::CommandError;

const OUTSIDE_ROOTS: &str = "Path is outside the workspace and open documents";

fn has_parent_segment(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn normalize_without_parent(path: &Path) -> PathBuf {
    path.components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect()
}

fn deepest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn canonical_roots(allowed_roots: &[String]) -> Result<Vec<PathBuf>, CommandError> {
    let mut roots = Vec::new();
    for raw in allowed_roots {
        if raw.is_empty() {
            continue;
        }
        let root = Path::new(raw);
        if !root.is_absolute() {
            return Err(CommandError::invalid_input("Allowed root must be absolute"));
        }
        if has_parent_segment(root) {
            return Err(CommandError::invalid_input(
                "Allowed root must not contain '..' segments",
            ));
        }
        roots.push(root.canonicalize().map_err(|e| {
            CommandError::from_io(&e, format!("Failed to resolve allowed root '{raw}': {e}"))
        })?);
    }
    if roots.is_empty() {
        return Err(CommandError::permission_denied(
            "No workspace or open document to scope this path to",
        ));
    }
    Ok(roots)
}

fn ensure_within_any_root(candidate: &Path, roots: &[PathBuf]) -> Result<(), CommandError> {
    if roots.iter().any(|root| candidate.starts_with(root)) {
        return Ok(());
    }
    Err(CommandError::permission_denied(OUTSIDE_ROOTS))
}

pub(crate) fn validate_mcp_bridge_path(
    file_path: &str,
    allowed_roots: &[String],
) -> Result<(), CommandError> {
    if file_path.is_empty() {
        return Err(CommandError::invalid_input(
            "Path must be a non-empty string",
        ));
    }
    // Reject a NUL byte to match the JS policy (fail closed). For a *new* file
    // only the deepest existing ancestor is canonicalized, so a NUL-tailed name
    // would otherwise slip through here even though the OS can never create it.
    if file_path.contains('\0') {
        return Err(CommandError::invalid_input(
            "Path must not contain a null byte",
        ));
    }

    let path = Path::new(file_path);
    if !path.is_absolute() {
        return Err(CommandError::invalid_input("Path must be absolute"));
    }
    if has_parent_segment(path) {
        return Err(CommandError::invalid_input(
            "Path must not contain '..' segments",
        ));
    }

    let roots = canonical_roots(allowed_roots)?;
    let normalized = normalize_without_parent(path);

    if normalized.exists() {
        let canonical = normalized.canonicalize().map_err(|e| {
            CommandError::from_io(&e, format!("Failed to resolve '{file_path}': {e}"))
        })?;
        return ensure_within_any_root(&canonical, &roots);
    }

    let Some(existing) = deepest_existing_ancestor(&normalized) else {
        return Err(CommandError::permission_denied(OUTSIDE_ROOTS));
    };
    let canonical_ancestor = existing.canonicalize().map_err(|e| {
        CommandError::from_io(
            &e,
            format!("Failed to resolve '{}': {e}", existing.display()),
        )
    })?;
    ensure_within_any_root(&canonical_ancestor, &roots)
}

/// Tauri command invoked from `bridgePathGuard.ts`. The `file_path` /
/// `allowed_roots` names are part of the JS↔Rust contract (see module header) —
/// do not rename without updating the JS invoke args and their pinning test.
#[tauri::command]
pub fn mcp_bridge_check_path(
    file_path: String,
    allowed_roots: Vec<String>,
) -> Result<(), CommandError> {
    validate_mcp_bridge_path(&file_path, &allowed_roots)
}

#[cfg(test)]
#[path = "path_guard.test.rs"]
mod tests;
