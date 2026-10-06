//! What the dynamic submenus contain, decided apart from building them.
//!
//! Purpose: the item ids, labels, accelerator and grouping of the Open Recent,
//! Open Recent Workspace and Genies submenus. `dynamic.rs` turns these into
//! native menu items, which can only be created on the main thread; keeping
//! the decisions here leaves them plain functions a test can call.
//!
//! The ids are a contract with the click handler: `recent-file-{n}`,
//! `recent-workspace-{n}` and `genie-item-{n}` name index `n` of the snapshot
//! stored when the menu was built (`events/dispatch.rs`).
//!
//! @coordinates-with dynamic.rs — builds the native items from these
//! @module menu/dynamic_layout

use std::collections::{BTreeMap, HashMap};

use crate::genies::GenieMenuEntry;

/// `(item id, label)` for each recent path, in order: the id is
/// `{prefix}-{index}` — the index the click handler resolves through the
/// snapshot — and the label is the last path component, or the whole path
/// when it has none (`/`, `..`).
pub(super) fn recent_entries<'a>(prefix: &str, paths: &'a [String]) -> Vec<(String, &'a str)> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let label = std::path::Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path);
            (format!("{prefix}-{index}"), label)
        })
        .collect()
}

/// The "Search Genies…" accelerator. A shortcuts map overrides the default:
/// an empty value means the user unbound it; a key absent from the map, or no
/// map at all, keeps `CmdOrCtrl+Y`.
pub(super) fn search_genies_accelerator(
    shortcuts: Option<&HashMap<String, String>>,
) -> Option<String> {
    match shortcuts.and_then(|s| s.get("search-genies")) {
        Some(v) if v.is_empty() => None,
        Some(v) => Some(v.clone()),
        None => Some("CmdOrCtrl+Y".to_string()),
    }
}

/// Where each genie goes in the menu: root-level entries first, in scan
/// order, then one group per category sorted by name, each keeping scan
/// order. Every item's id is `genie-item-{n}`, where `n` is its path's index
/// in `snapshot` — the list the click handler resolves ids through.
pub(super) struct GenieLayout<'a> {
    pub(super) root: Vec<(String, &'a str)>,
    pub(super) groups: Vec<(&'a str, Vec<(String, &'a str)>)>,
    pub(super) snapshot: Vec<String>,
}

pub(super) fn genie_layout(entries: &[GenieMenuEntry]) -> GenieLayout<'_> {
    let mut root = Vec::new();
    let mut grouped: BTreeMap<&str, Vec<&GenieMenuEntry>> = BTreeMap::new();
    for entry in entries {
        match entry.category.as_deref() {
            None => root.push(entry),
            Some(category) => grouped.entry(category).or_default().push(entry),
        }
    }
    let mut snapshot = Vec::new();
    let root = place_genies(root, &mut snapshot);
    let groups = grouped
        .into_iter()
        .map(|(name, members)| (name, place_genies(members, &mut snapshot)))
        .collect();
    GenieLayout {
        root,
        groups,
        snapshot,
    }
}

/// Give each entry the next snapshot slot: its path goes in, its id names it.
fn place_genies<'a>(
    entries: Vec<&'a GenieMenuEntry>,
    snapshot: &mut Vec<String>,
) -> Vec<(String, &'a str)> {
    entries
        .into_iter()
        .map(|entry| {
            snapshot.push(entry.path.clone());
            (
                format!("genie-item-{}", snapshot.len() - 1),
                entry.title.as_str(),
            )
        })
        .collect()
}

#[cfg(test)]
#[path = "dynamic_layout.test.rs"]
mod tests;
