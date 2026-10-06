//! Additive, idempotent hook configuration. Invalid user config is never replaced.
//!
//! A CLI config is the user's own file, and they may keep it as a symlink into
//! a dotfiles checkout. Renaming a new file over that link would turn it into
//! a regular file: the checkout keeps the old content and the link is gone. So
//! a link is resolved first and the replacement lands on the file it names. A
//! link that leads nowhere (dangling, or a loop) is an error, not an invitation
//! to create a config somewhere the user never put one.
//!
//! @coordinates-with atomic_replace.rs — the synced temp-file-and-rename write, and link resolution
//! @module terminal_transcript/config
use crate::atomic_replace::{
    atomic_replace, resolve_link_target, AtomicReplaceError, LinkResolveError,
};
use crate::command_error::CommandError;
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
/// Returns whether the config changed — callers write the file only then, so an
/// already-configured CLI file is never rewritten (or reformatted).
pub(super) fn add_hook(config: &mut Value, command: &str) -> Result<bool, CommandError> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| CommandError::invalid_input("CLI configuration must be an object"))?;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| CommandError::invalid_input("CLI hooks must be an object"))?;
    let groups = hooks
        .entry("SessionStart")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| CommandError::invalid_input("SessionStart hooks must be an array"))?;
    if groups.iter().any(|group| {
        group["hooks"]
            .as_array()
            .is_some_and(|hooks| hooks.iter().any(|hook| hook["command"] == command))
    }) {
        return Ok(false);
    }
    groups.push(json!({"hooks":[{"type":"command", "command": command, "timeout": 5}]}));
    Ok(true)
}
/// The file a config path really names: the path itself, or the file a
/// symlink there leads to. Both the read and the write go to the result.
pub(super) fn resolve_target(path: &Path) -> Result<PathBuf, CommandError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {}
        // A regular file, or nothing there yet: the path is the target.
        Ok(_) => return Ok(path.to_path_buf()),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(path.to_path_buf()),
        Err(e) => return Err(CommandError::io(format!("{}: {e}", path.display()))),
    }
    let target = resolve_link_target(path).map_err(|error| match error {
        LinkResolveError::TooManyLinks => {
            CommandError::invalid_input(format!("{} is a symlink loop", path.display()))
        }
        LinkResolveError::ReadLink(e) => CommandError::io(format!("{}: {e}", path.display())),
        LinkResolveError::ReferentParentMissing(parent) => CommandError::not_found(format!(
            "{} links into a missing directory: {}",
            path.display(),
            parent.display()
        )),
    })?;
    // Link resolution names the file a dangling link points at, so that a
    // document save can create it. A config is different: no file there means
    // the user's real config is not where they said it is.
    if !target.exists() {
        return Err(CommandError::not_found(format!(
            "{} links to a missing file: {}",
            path.display(),
            target.display()
        )));
    }
    Ok(target)
}
/// Replace `target` with `bytes`: a temp file beside it, synced, then renamed
/// over it, keeping the mode an existing file had. `target` is used as given —
/// pass a config path through [`resolve_target`] first.
pub(super) fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let parent = target.parent().ok_or_else(|| {
        CommandError::invalid_input(format!("{} has no parent directory", target.display()))
    })?;
    std::fs::create_dir_all(parent).map_err(|e| CommandError::io(e.to_string()))?;
    atomic_replace(target, parent, bytes).map_err(|error| {
        let cause = match error {
            AtomicReplaceError::CreateTemp { source, .. } => source.to_string(),
            AtomicReplaceError::WriteTemp(e)
            | AtomicReplaceError::FlushTemp(e)
            | AtomicReplaceError::SyncTemp(e) => e.to_string(),
            AtomicReplaceError::Persist(e) => e.error.to_string(),
        };
        CommandError::io(format!("{}: {cause}", target.display()))
    })
}
#[cfg(test)]
#[path = "config.test.rs"]
mod tests;
