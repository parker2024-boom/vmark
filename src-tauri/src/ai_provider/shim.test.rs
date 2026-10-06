//! WI-RA4.1 — stand-in CLI binaries for tests that drive a CLI provider.
//!
//! A CLI provider is handed its prompt on stdin, so a stand-in has to be a
//! program that reads it: an existing binary such as `/bin/echo` only ever saw
//! the prompt as an argument. Unix-only — the stand-in is a `/bin/sh` script.

/// Write an executable `/bin/sh` script running `body` into a fresh temp
/// directory and return its path. The directory lives as long as the guard.
pub(crate) fn sh_shim(body: &str) -> (tempfile::TempDir, String) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fake-cli");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write shim");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (dir, path.to_str().expect("utf-8 path").to_string())
}
