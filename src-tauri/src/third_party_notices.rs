//! Purpose: open the third-party notices the app bundles, from Settings → About.
//!
//! The file is `THIRD_PARTY_LICENSES.txt`, written by
//! `scripts/gen-third-party-licenses.mjs` and shipped through
//! `tauri.conf.json` → `bundle.resources`. MIT, BSD, ISC and Apache require
//! their notices to accompany a binary distribution; this is where a user
//! finds them.
//!
//! Key decisions:
//!   - **Rust resolves and opens the path.** The Settings window has no
//!     filesystem or open-path permission and should not gain one for a single
//!     fixed file: the webview asks for "the notices", never for a path.
//!   - **A missing file is `not-found`, not a silent no-op.** The resource is
//!     joined to the bundle manifest by `bundle_manifest.test.rs`, so a miss at
//!     runtime is a packaging fault worth surfacing.
//!
//! @coordinates-with scripts/gen-third-party-licenses.mjs — writes the file
//! @coordinates-with src-tauri/src/content_server/bundle_manifest.test.rs — joins the path to `bundle.resources`
//! @coordinates-with src/pages/settings/AboutSettings.tsx — the button that calls the command
//! @module third_party_notices

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::command_error::CommandError;

/// Path of the notices file relative to Tauri's `Resource` base directory. A
/// glob-form `bundle.resources` entry keeps the source path, so this is also
/// the file's path under `src-tauri/`.
pub const NOTICES_RESOURCE: &str = "resources/generated/THIRD_PARTY_LICENSES.txt";

/// The notices file under `resource_dir`, or `not-found` naming where it looked.
pub fn notices_file_in(resource_dir: &Path) -> Result<PathBuf, CommandError> {
    let file = resource_dir.join(NOTICES_RESOURCE);
    if file.is_file() {
        Ok(file)
    } else {
        Err(CommandError::not_found(format!(
            "third-party notices are missing from the app bundle: {}",
            file.display()
        )))
    }
}

/// Open the bundled notices in the system's default viewer for text files.
#[tauri::command]
pub fn open_third_party_notices(app: AppHandle) -> Result<(), CommandError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| CommandError::internal(format!("cannot locate the app's resources: {e}")))?;
    let file = notices_file_in(&resource_dir)?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|e| CommandError::io(format!("cannot open {}: {e}", file.display())))
}

#[cfg(test)]
#[path = "third_party_notices.test.rs"]
mod third_party_notices_test;
