//! # Content Search — Per-File Scan
//!
//! Purpose: everything the search does with ONE file — decide whether it is
//! text worth reading, read it, and collect its matching lines.
//!
//! Key decisions:
//!   - One open per file. The binary probe, the size check and the read all go
//!     through the same handle: the size is `fstat` on it, not a second path
//!     lookup, and the read continues from where the probe stopped. A file is
//!     therefore judged and read as ONE object even if its path is replaced
//!     in between.
//!   - The order of the checks is part of the contract. Binary comes first, so
//!     a binary file is a by-design exclusion however large it is; only then
//!     does an oversized TEXT file count as eligible-but-unscanned.
//!   - The read is bounded by `MAX_FILE_SIZE` even if the file grows after the
//!     size check.
//!
//! @coordinates-with content_search_walk.rs — sole caller; applies each `FileScan` to the tally
//! @coordinates-with content_search_match.rs — line matching and the binary rule
//! @module content_search_file

use super::matching::{looks_binary, search_line, LineMatch, BINARY_CHECK_LEN};
use super::walk::DeadlineBudget;
use super::{MAX_FILE_SIZE, MAX_MATCHES};
use regex::Regex;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// What scanning one file came to.
#[derive(Debug)]
pub(super) enum FileScan {
    /// Not a file the search covers (binary). By design — not missing evidence.
    Excluded,
    /// Eligible, but its content was not read: it could not be opened or
    /// read, is oversized, or is not UTF-8. Voids completeness.
    Unscanned,
    /// The budget ran out before the read. Voids completeness and ends the walk.
    OutOfTime,
    /// Read and searched. `finished` is false when the match cap or the budget
    /// cut the line scan short, which voids completeness.
    Scanned {
        matches: Vec<LineMatch>,
        finished: bool,
    },
}

/// Scan the file at `path`, adding its match count to `total_matches`.
pub(super) fn scan_file(
    path: &Path,
    re: &Regex,
    budget: &DeadlineBudget,
    total_matches: &mut usize,
) -> FileScan {
    // A file that cannot be opened is not "binary": its content is evidence
    // nobody looked at, so it must void completeness rather than pass as a
    // by-design exclusion.
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) => {
            log::debug!("[ContentSearch] Cannot open file {:?}: {e}", path);
            return FileScan::Unscanned;
        }
    };
    scan_open_file(&mut file, path, re, budget, total_matches)
}

/// Scan an already-open file. `path` is only named in logs: every read and
/// the size check go through `file`.
pub(super) fn scan_open_file(
    file: &mut File,
    path: &Path,
    re: &Regex,
    budget: &DeadlineBudget,
    total_matches: &mut usize,
) -> FileScan {
    let mut bytes = vec![0u8; BINARY_CHECK_LEN];
    let head_len = match file.read(&mut bytes) {
        Ok(head_len) => head_len,
        Err(e) => {
            log::debug!("[ContentSearch] Cannot read file {:?}: {e}", path);
            return FileScan::Unscanned;
        }
    };
    bytes.truncate(head_len);
    if looks_binary(&bytes) {
        return FileScan::Excluded;
    }

    // Skip files larger than MAX_FILE_SIZE to prevent memory pressure
    if let Ok(meta) = file.metadata() {
        if meta.len() > MAX_FILE_SIZE {
            log::debug!(
                "[ContentSearch] Skipping large file ({} bytes): {:?}",
                meta.len(),
                path
            );
            return FileScan::Unscanned;
        }
    }

    // Re-check the deadline before an expensive blocking read.
    if budget.spent() {
        return FileScan::OutOfTime;
    }

    // One byte past the limit is enough to know the file outgrew it.
    let remaining = (MAX_FILE_SIZE + 1).saturating_sub(head_len as u64);
    let read = file.by_ref().take(remaining).read_to_end(&mut bytes);
    if read.is_err() || bytes.len() as u64 > MAX_FILE_SIZE {
        log::debug!("[ContentSearch] Cannot read file: {:?}", path);
        return FileScan::Unscanned;
    }
    let Ok(content) = String::from_utf8(bytes) else {
        log::debug!("[ContentSearch] Cannot read file: {:?}", path);
        return FileScan::Unscanned;
    };

    let (matches, finished) = scan_lines(&content, re, budget, total_matches);
    FileScan::Scanned { matches, finished }
}

/// Collect the matching lines of `content`. Returns them with whether every
/// line was looked at: the scan stops early once `total_matches` reaches
/// `MAX_MATCHES` or the budget is spent.
fn scan_lines(
    content: &str,
    re: &Regex,
    budget: &DeadlineBudget,
    total_matches: &mut usize,
) -> (Vec<LineMatch>, bool) {
    let mut matches: Vec<LineMatch> = Vec::new();

    for (line_idx, line) in content.lines().enumerate() {
        if *total_matches >= MAX_MATCHES {
            return (matches, false); // remaining lines were never scanned
        }
        // Cheap periodic deadline check on very long files.
        if budget.spent_at_step(line_idx) {
            return (matches, false);
        }

        if let Some(mut line_match) = search_line(line, (line_idx + 1) as u32, re) {
            // Never exceed MAX_MATCHES: a single line can carry many
            // ranges, so truncate to the remaining budget.
            // (the pre-line check above guarantees remaining >= 1)
            line_match
                .match_ranges
                .truncate(MAX_MATCHES - *total_matches);
            *total_matches += line_match.match_ranges.len();
            matches.push(line_match);
        }
    }

    (matches, true)
}

#[cfg(test)]
#[path = "content_search_file.test.rs"]
mod tests;
