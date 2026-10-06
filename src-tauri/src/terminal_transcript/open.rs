//! Opening a transcript: a regular file, or nothing.
//!
//! Purpose: the path comes from a binding file a CLI hook wrote, so what sits
//! at it is not ours to assume. Opening a FIFO for reading waits until some
//! process opens it for writing — on a blocking-pool thread, for as long as
//! that takes — and a device can do worse.
//!
//! Key decisions:
//!   - The type is checked BEFORE the open (`lstat`), so a FIFO or a device is
//!     never opened at all.
//!   - The open is non-blocking and does not follow a link in the final
//!     component, and the type is checked again through the descriptor. That
//!     covers what the first check cannot: a FIFO swapped in between the check
//!     and the open no longer blocks, and a link swapped in — which would lead
//!     outside the session roots the caller confined the path to — is refused.
//!     Non-blocking mode changes nothing for a regular file's reads.
//!   - A path that is gone is not an error: a CLI announces its transcript
//!     before writing it, so absent means "still waiting".
//!
//! @coordinates-with terminal_transcript/mod.rs — confines the path first
//! @module terminal_transcript/open

use crate::command_error::CommandError;
use std::fs::{File, Metadata, OpenOptions};
use std::io::ErrorKind;
use std::path::Path;

fn io_error(error: std::io::Error) -> CommandError {
    CommandError::io(error.to_string())
}

fn not_regular() -> CommandError {
    CommandError::invalid_input("Transcript must be a regular file")
}

/// Open `path` for reading if it is a regular file, returning it with the
/// metadata read through the opened descriptor. `None` when nothing is there.
pub(super) fn open_regular(path: &Path) -> Result<Option<(File, Metadata)>, CommandError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Err(not_regular()),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    };
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() {
        return Err(not_regular());
    }
    Ok(Some((file, meta)))
}

#[cfg(test)]
#[path = "open.test.rs"]
mod tests;
