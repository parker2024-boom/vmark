//! Unit tests for the CLI install/uninstall module (see `mod.rs`).
//! Split into a sibling file to keep `mod.rs` under the size gate. The
//! install flow itself is exercised in `install_flow.test.rs`.

use super::*;

#[test]
fn script_content_is_valid_bash() {
    assert!(SCRIPT_CONTENT.starts_with("#!/bin/bash\n"));
    assert!(SCRIPT_CONTENT.ends_with('\n'));
    assert!(SCRIPT_CONTENT.contains("open -b app.vmark"));
    // The content travels inside a command-line argument, which cannot hold a NUL.
    assert!(!SCRIPT_CONTENT.contains('\0'));
}

#[test]
fn error_display_cancelled() {
    assert_eq!(
        CliInstallError::Cancelled.to_string(),
        "Operation cancelled."
    );
}

#[test]
fn error_display_foreign() {
    let msg = CliInstallError::ForeignFile.to_string();
    assert!(msg.contains(CLI_PATH));
    assert!(msg.contains("not installed by VMark"));
}

#[test]
fn error_display_failed() {
    let msg = CliInstallError::Failed("boom".to_string()).to_string();
    assert_eq!(msg, "boom");
}

#[test]
fn error_into_string() {
    let s: String = CliInstallError::Cancelled.into();
    assert_eq!(s, "Operation cancelled.");
}

#[test]
fn status_not_installed_when_path_missing() {
    // /usr/local/bin/vmark likely doesn't exist in CI/test environments
    // This test is environment-dependent but safe to run
    let status = cli_install_status();
    assert!(status.is_ok());
    // We can't assert installed/foreign since the file may or may not exist
}
