//! Canonicalization and content hashing (pure — ADR-C4). Spec §3.
//!
//! Text pipeline: UTF-8 → NFC → LF, then identity masking (the reserved
//! `vmark.id`/`vmark.schema` lines are excluded), then SHA-256. Binary
//! content hashes raw bytes with no canonicalization (§3.4). The CAS
//! stores exactly the masked canonical bytes (§4.2), so every snapshot is
//! self-verifying against its key.

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::types::ContentHash;

#[cfg(test)]
thread_local! {
    /// (canonicalizations, text content hashes) on this thread, so a test can
    /// pin how often a write path pays for each. Per thread: tests run in
    /// parallel and must not see each other's work.
    static HASHING_COUNTS: std::cell::Cell<(usize, usize)> =
        const { std::cell::Cell::new((0, 0)) };
}

#[cfg(test)]
fn count_hashing(canonicalized: usize, hashed: usize) {
    HASHING_COUNTS.with(|c| {
        let (a, b) = c.get();
        c.set((a + canonicalized, b + hashed));
    });
}

/// Test-only: zero this thread's counts.
#[cfg(test)]
pub(crate) fn reset_hashing_counts() {
    HASHING_COUNTS.with(|c| c.set((0, 0)));
}

/// Test-only: (canonicalizations, text content hashes) since the last reset.
#[cfg(test)]
pub(crate) fn hashing_counts() -> (usize, usize) {
    HASHING_COUNTS.with(std::cell::Cell::get)
}

/// NFC + LF normalization (spec §3.1). No other transformation: trailing
/// whitespace and final-newline presence are content.
pub fn canonicalize_text(input: &str) -> String {
    #[cfg(test)]
    count_hashing(1, 0);
    let nfc: String = input.nfc().collect();
    // \r\n and bare \r both become \n.
    let mut out = String::with_capacity(nfc.len());
    let mut chars = nfc.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// Remove the reserved identity keys from a canonical (LF) document's
/// frontmatter (spec §3.2 / §2.1): drop `id:`/`schema:` lines inside the
/// top-level `vmark:` mapping, drop the mapping if emptied, drop the
/// whole frontmatter block if emptied. Malformed frontmatter (no closing
/// fence) is content — returned untouched.
pub fn mask_identity(text: &str) -> String {
    let Some(after) = text.strip_prefix("---\n") else {
        return text.to_string();
    };
    // `fence_nl` preserves whether the closing fence carried a trailing
    // newline (audit A-M1): masking must never invent one — the final
    // newline is content (§3.1).
    let (fm, rest, fence_nl) = if let Some(pos) = after.find("\n---\n") {
        (&after[..pos], &after[pos + 5..], true)
    } else if let Some(stripped) = after.strip_suffix("\n---") {
        (stripped, "", false)
    } else {
        return text.to_string();
    };

    let lines: Vec<&str> = fm.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim_end() == "vmark:" {
            let mut kept: Vec<&str> = Vec::new();
            let mut j = i + 1;
            while j < lines.len() && lines[j].starts_with([' ', '\t']) {
                let t = lines[j].trim_start();
                if !(t.starts_with("id:") || t.starts_with("schema:")) {
                    kept.push(lines[j]);
                }
                j += 1;
            }
            if !kept.is_empty() {
                out.push(line);
                out.extend(kept);
            }
            i = j;
        } else {
            out.push(line);
            i += 1;
        }
    }
    let masked_fm = out.join("\n");
    if masked_fm.trim().is_empty() {
        rest.to_string()
    } else if fence_nl {
        format!("---\n{masked_fm}\n---\n{rest}")
    } else {
        format!("---\n{masked_fm}\n---")
    }
}

/// A text document's identity-masked canonical bytes (what the CAS stores,
/// spec §4.2) together with their hash (spec §3.2). Computed as one value so a
/// write path canonicalizes and hashes its content once and hands both on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskedText {
    pub bytes: String,
    pub hash: ContentHash,
}

/// Mask and hash text that is ALREADY canonical — the output of
/// `canonicalize_text`, or text built from it by joining at line boundaries
/// (`insert_identity`, `assign_identity`), which keeps it canonical. Passing
/// raw text here skips canonicalization and records the wrong hash; use
/// `masked_text` for that.
pub fn mask_and_hash_canonical(canonical: &str) -> MaskedText {
    let bytes = mask_identity(canonical);
    #[cfg(test)]
    count_hashing(0, 1);
    let digest: [u8; 32] = Sha256::digest(bytes.as_bytes()).into();
    MaskedText {
        bytes,
        hash: ContentHash::from_digest(&digest),
    }
}

/// Canonicalize, mask and hash raw text in one pass.
pub fn masked_text(input: &str) -> MaskedText {
    mask_and_hash_canonical(&canonicalize_text(input))
}

/// Spec §3.2: hash of the identity-masked canonical bytes.
pub fn text_content_hash(input: &str) -> ContentHash {
    masked_text(input).hash
}

/// Spec §3.4: raw-byte hashing for binary content.
pub fn binary_content_hash(bytes: &[u8]) -> ContentHash {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    ContentHash::from_digest(&digest)
}

/// Inverse of `mask_identity` for materialization (spec §4.2) and first
/// capture (spec §2.1): insert the reserved `vmark:` block, preserving
/// author frontmatter byte-for-byte. Appended at the end of an existing
/// frontmatter block, or a new block is prepended. Malformed frontmatter
/// (unterminated fence) is content — a fresh block is prepended above it.
pub fn insert_identity(text: &str, id: &str, schema: Option<&str>) -> String {
    let reserved = match schema {
        Some(s) => format!("  id: {id}\n  schema: {s}"),
        None => format!("  id: {id}"),
    };
    let vmark_block = format!("vmark:\n{reserved}");
    if let Some(after) = text.strip_prefix("---\n") {
        let (fm, rest) = if let Some(pos) = after.find("\n---\n") {
            (&after[..pos], &after[pos + 5..])
        } else if let Some(fm) = after.strip_suffix("\n---") {
            (fm, "")
        } else {
            // Unterminated fence: content — prepend a fresh block above.
            return format!("---\n{vmark_block}\n---\n{text}");
        };
        // Merge into an EXISTING vmark mapping (it may carry unknown
        // children masking preserved) — a second mapping would shadow the
        // identity from read_identity. Existing `id:`/`schema:`
        // children are REPLACED, not kept: they are kernel-namespace lines
        // (mask_identity strips them, so dropping them never moves the
        // content hash), and keeping one would leave a duplicate key —
        // invalid YAML (dogfood session 2 finding).
        if let Some(existing_pos) = fm.split('\n').position(|line| line.trim_end() == "vmark:") {
            let lines: Vec<&str> = fm.split('\n').collect();
            let mut rebuilt: Vec<String> = Vec::with_capacity(lines.len() + 2);
            for (i, line) in lines.iter().enumerate() {
                let in_vmark_children = i > existing_pos
                    && lines[existing_pos + 1..=i]
                        .iter()
                        .all(|l| l.starts_with([' ', '\t']));
                if in_vmark_children {
                    let t = line.trim_start();
                    if t.starts_with("id:") || t.starts_with("schema:") {
                        continue;
                    }
                }
                rebuilt.push((*line).to_string());
                if i == existing_pos {
                    rebuilt.push(reserved.clone());
                }
            }
            let fm2 = rebuilt.join("\n");
            return format!("---\n{fm2}\n---\n{rest}");
        }
        return format!("---\n{fm}\n{vmark_block}\n---\n{rest}");
    }
    format!("---\n{vmark_block}\n---\n{text}")
}

/// Spec §3.1/§3.4: invalid UTF-8 means the file is treated as binary.
pub fn is_probably_binary(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_err()
}

#[cfg(test)]
#[path = "canonical.test.rs"]
mod tests;
