//! The payloads a workspace transfer carries between windows.
//!
//! Split out of `workspace/transfer.rs` to keep it under the size gate: these
//! are the serialized shapes the frontend sends and receives, and nothing here
//! has behaviour.
//!
//! @coordinates-with workspace/transfer.rs — the registry and commands that carry them
//! @module workspace/transfer/payloads

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTransferTabData {
    pub tab_id: String,
    pub title: String,
    pub file_path: Option<String>,
    pub content: String,
    pub saved_content: String,
    pub is_dirty: bool,
    pub read_only: bool,
    pub is_pinned: bool,
    pub format_id: String,
    pub editing_enabled: Option<bool>,
    pub active_schema_id: Option<String>,
    /// Line convention the FILE has on disk. Canonical LF content cannot carry
    /// it, so a transfer that omitted these rewrote a CRLF+BOM file to LF and
    /// BOM-less on its first save in the destination window. `Option` because
    /// payloads written by older builds have none — the receiver then falls
    /// back to detection, which is what it did for every payload before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_ending: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_break_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_bom: Option<bool>,
    /// RAW disk bytes, so external-change detection in the destination compares
    /// against what is actually on disk rather than the canonical editor text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_disk_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTransferData {
    pub request_id: String,
    pub operation: String,
    pub source_window_label: String,
    pub workspace_instance_id: String,
    pub kind: String,
    pub root_id: Option<String>,
    pub root_path: Option<String>,
    pub display_name: String,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<WorkspaceTransferTabData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTransferAck {
    pub request_id: String,
    pub target_window_label: String,
    pub workspace_instance_id: String,
}
