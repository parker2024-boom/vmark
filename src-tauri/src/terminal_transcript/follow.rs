//! Following a transcript: which bytes to read, and from where.
//!
//! Purpose: the transcript panel polls once a second while a CLI streams.
//! Answering each poll with the whole tail meant megabytes of IPC per second
//! to deliver a few new lines. Here the caller hands back the cursor it was
//! last given and receives only the complete records appended since.
//!
//! Key decisions:
//!   - A cursor is resumed only when the file is provably the one it was taken
//!     from and has only grown: same identity (path, session, and on Unix the
//!     device and inode), not smaller, and the byte before the offset still a
//!     newline. Anything else — a first read, a truncation, a replaced file,
//!     an in-place rewrite, more unread bytes than the bound — is answered
//!     with a fresh bounded tail and `reset: true`.
//!   - Only whole records travel. Every answer ends at the last newline, so a
//!     record still being written is delivered once it is complete, and no
//!     UTF-8 sequence is ever cut: a newline byte is never part of one.
//!   - Nothing is read when neither the size nor the modification time moved.
//!   - Size, time and identity all come from one `fstat` of the descriptor the
//!     bytes are then read from (`open.rs`), never from a second look at the
//!     path.
//!
//! @coordinates-with terminal_transcript/mod.rs — confines the path, then calls `follow`
//! @coordinates-with terminal_transcript/open.rs — opens the file, regular files only
//! @coordinates-with src/components/Terminal/useTerminalTranscript.ts — echoes the cursor
//! @module terminal_transcript/follow

use super::open::open_regular;
use crate::command_error::CommandError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Where a reader stopped. Opaque to the frontend, which only echoes it back;
/// every field is re-checked here, so a cursor that lies costs a fresh tail,
/// never a read outside the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCursor {
    /// Which file the offset belongs to.
    identity: String,
    /// End of the last whole record delivered.
    offset: u64,
    /// The file's size when it was last looked at.
    size: u64,
    /// The file's modification time when it was last looked at.
    modified: String,
}

/// One answer to a poll.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDelta {
    pub(super) cursor: TranscriptCursor,
    /// True when `data` is a fresh tail that replaces whatever the caller
    /// holds; false when it continues from the cursor the caller sent.
    pub(super) reset: bool,
    /// Whole records only. Empty when nothing new is complete yet.
    pub(super) data: String,
}

fn io_error(error: std::io::Error) -> CommandError {
    CommandError::io(error.to_string())
}

/// What makes two looks at a path the same file. A replaced file keeps its
/// path and gets a new inode; a new CLI session gets a new path or session id.
fn identity(path: &Path, session: &Value, meta: &Metadata) -> String {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    };
    #[cfg(not(unix))]
    let file = format!("{:?}", meta.created().ok());
    format!("{}:{session}:{file}", path.display())
}

fn modified(meta: &Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_nanos().to_string())
        .unwrap_or_default()
}

fn read_range(file: &mut File, start: u64, length: u64) -> Result<Vec<u8>, CommandError> {
    file.seek(SeekFrom::Start(start)).map_err(io_error)?;
    let mut bytes = Vec::new();
    file.take(length)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    Ok(bytes)
}

/// True when `offset` is where a record begins: the start of the file, or
/// right after a newline.
fn starts_a_record(file: &mut File, offset: u64) -> Result<bool, CommandError> {
    if offset == 0 {
        return Ok(true);
    }
    Ok(read_range(file, offset - 1, 1)? == b"\n")
}

/// Length of the leading part of `bytes` that consists of whole records.
fn whole_records(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |last| last + 1)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Answer a poll for the transcript at `path` (already confined by the
/// caller). `None` while the file does not exist yet.
pub(super) fn follow(
    path: &Path,
    session: &Value,
    previous: Option<&TranscriptCursor>,
    limit: u64,
) -> Result<Option<TranscriptDelta>, CommandError> {
    let Some((mut file, meta)) = open_regular(path)? else {
        return Ok(None);
    };
    let size = meta.len();
    let stamp = |offset| TranscriptCursor {
        identity: identity(path, session, &meta),
        offset,
        size,
        modified: modified(&meta),
    };

    let resumable = previous.filter(|previous| {
        previous.identity == identity(path, session, &meta)
            && previous.offset <= previous.size
            && previous.size <= size
    });
    if let Some(previous) = resumable {
        if previous.size == size {
            // Same size and time: nothing moved, nothing to read. Same size
            // but a new time is a rewrite in place — start over below.
            if previous.modified == modified(&meta) {
                return Ok(Some(TranscriptDelta {
                    cursor: previous.clone(),
                    reset: false,
                    data: String::new(),
                }));
            }
        } else if size - previous.offset <= limit && starts_a_record(&mut file, previous.offset)? {
            let bytes = read_range(&mut file, previous.offset, size - previous.offset)?;
            let whole = whole_records(&bytes);
            return Ok(Some(TranscriptDelta {
                cursor: stamp(previous.offset + whole as u64),
                reset: false,
                data: text(&bytes[..whole]),
            }));
        }
    }

    // A fresh tail: at most `limit` bytes, from the first record that starts
    // inside the window to the last one that is complete.
    let start = size.saturating_sub(limit);
    let bytes = read_range(&mut file, start, size - start)?;
    let skipped = if starts_a_record(&mut file, start)? {
        0
    } else {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |first| first + 1)
    };
    let whole = whole_records(&bytes[skipped..]);
    Ok(Some(TranscriptDelta {
        cursor: stamp(start + (skipped + whole) as u64),
        reset: true,
        data: text(&bytes[skipped..skipped + whole]),
    }))
}

#[cfg(test)]
#[path = "follow.test.rs"]
mod tests;
