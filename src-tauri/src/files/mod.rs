//! # Files
//!
//! Purpose: the document-file commands the frontend calls directly — opening
//! (Finder/CLI queueing), saving, claiming a new name, metadata and trash, and
//! the sidebar's one-call tree listing. Each child is its own module; this
//! file only groups them.
//!
//! - `open` — Finder/CLI open queueing, hot-open delivery, macOS reopen
//! - `write` — the atomic save command and its list guard (`write::anchored`
//!   holds the folder on Unix)
//! - `create` — `create_file_exclusive`, sharing `write`'s guard
//! - `ops` — file size and move-to-trash
//! - `tree_walk` — `list_directory_tree`; `tree` — its hidden-entry rule

pub(crate) mod create;
pub(crate) mod open;
pub(crate) mod ops;
mod tree;
pub(crate) mod tree_walk;
pub(crate) mod write;
