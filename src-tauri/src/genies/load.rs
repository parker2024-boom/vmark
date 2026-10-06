//! `load_genies` — every genie with its parsed content, in one IPC answer.
//!
//! The picker needs each genie's metadata and template. Listing the files and
//! then reading them one command at a time cost one IPC round trip per genie;
//! this command does the listing and every read in a single trip, on the
//! blocking pool.
//!
//! - A genie that cannot be read or parsed comes back with its `error` and no
//!   content, so one bad file does not cost the picker the others.
//! - The answer is bounded. Each file is already capped (`MAX_GENIE_BYTES`)
//!   and the listing is capped (`scanning.rs`), but their product is not a
//!   size to put in one message. Once the templates returned reach
//!   `MAX_BATCH_TEMPLATE_BYTES`, the genies that do not fit come back listed
//!   with neither content nor error, and the caller reads those one by one
//!   with `read_genie`.

use super::commands::{global_genies_dir, off_thread, read_genie_in};
use super::scanning::scan_genies_dir;
use super::types::{GenieContent, GenieEntry};
use crate::command_error::CommandError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::{command, AppHandle};

/// Most template bytes one `load_genies` answer carries. A genie is a few
/// kilobytes, so this holds thousands of ordinary genies while keeping a
/// directory of maximum-size files from becoming a multi-gigabyte message.
pub(crate) const MAX_BATCH_TEMPLATE_BYTES: usize = 8 * 1024 * 1024;

/// One listed genie and the outcome of reading it.
///
/// Serialized as the entry's own fields with `content` or `error` beside
/// them. Neither present means the genie was not read because the answer was
/// full; the caller reads it with `read_genie`.
#[derive(Debug, Serialize)]
pub struct LoadedGenie {
    /// The listing entry: name, path, source, category, kind.
    #[serde(flatten)]
    pub entry: GenieEntry,
    /// Parsed metadata and template, when the file was read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<GenieContent>,
    /// Why the file could not be read or parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CommandError>,
}

/// List the global genies directory and read every genie in it.
#[command]
pub async fn load_genies(app: AppHandle) -> Result<Vec<LoadedGenie>, CommandError> {
    let global_dir = global_genies_dir(&app).map_err(CommandError::internal)?;
    off_thread(move || load_genies_in(&global_dir)).await
}

/// `load_genies` against an explicit directory, with the default budget.
fn load_genies_in(global_dir: &Path) -> Vec<LoadedGenie> {
    load_genies_bounded(global_dir, MAX_BATCH_TEMPLATE_BYTES)
}

/// The listing, each entry read while its template still fits `budget` bytes.
/// A template that does not fit is left unread without ending the batch: a
/// smaller genie later in the list may still fit.
fn load_genies_bounded(global_dir: &Path, budget: usize) -> Vec<LoadedGenie> {
    let mut remaining = budget;
    list_genies_in(global_dir)
        .into_iter()
        .map(|entry| match read_genie_in(global_dir, &entry.path) {
            Ok(content) if content.template.len() <= remaining => {
                remaining -= content.template.len();
                LoadedGenie {
                    entry,
                    content: Some(content),
                    error: None,
                }
            }
            Ok(_) => LoadedGenie {
                entry,
                content: None,
                error: None,
            },
            Err(error) => LoadedGenie {
                entry,
                content: None,
                error: Some(error),
            },
        })
        .collect()
}

/// The scan behind the listing: bounded in depth and entry count by
/// `scan_genies_dir`, sorted by name.
fn list_genies_in(global_dir: &Path) -> Vec<GenieEntry> {
    let mut by_name: HashMap<String, GenieEntry> = HashMap::new();
    if global_dir.is_dir() {
        scan_genies_dir(global_dir, global_dir, "global", &mut by_name);
    }
    let mut entries: Vec<GenieEntry> = by_name.into_values().collect();
    // Path breaks a name tie: the display name is the file STEM, so
    // `writing/summarize.md` and `code/summarize.md` sort equal — and the
    // remaining order was `HashMap` iteration order, which differs between
    // runs of the same process, let alone between machines.
    entries.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    entries
}

#[cfg(test)]
#[path = "load.test.rs"]
mod tests;
