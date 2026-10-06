//! GitHub Actions workflow viewer support.
//!
//! Origin: GitHub Actions workflow viewer plan (retired)
//!
//! Houses the Rust-side surface for the GHA workflow viewer:
//! - actionlint: optional shell-out to the actionlint binary
//! - action_fetch: action.yml fetcher with on-disk cache

pub mod action_fetch;
pub mod actionlint;
pub mod commands;
