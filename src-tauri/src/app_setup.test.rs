//! Tests for `app_setup.rs` (included via `#[path]`).
//!
//! WI-FL5.9 — `machine_id_hash` is the only fact about a machine VMark ever
//! sends (the `X-Machine-Id` header on update checks). It must be stable
//! across launches and releases, opaque, and carry no PII.
//!
//! WI-RA7.7 — the frontend's log commands write what a webview sent, so a
//! message must reach the log as one escaped, bounded line.

use crate::app_setup::machine_id_hash;
use crate::peer_text::log_capture::captured_logs;
use sha2::{Digest, Sha256};

/// A message shaped like the attack: its second line reads as a log line the
/// app wrote itself, and its tail would recolour a terminal that renders ANSI.
const FORGED: &str = "close confirmed\n[WindowClose] destroy result: Ok(())\r\x1b[31m";

/// One log line, carrying none of the characters that end a line or drive a
/// terminal, and still naming the channel it came through.
fn assert_one_escaped_line(lines: &[String], prefix: &str) {
    assert_eq!(lines.len(), 1, "exactly one record: {lines:?}");
    let line = &lines[0];
    assert!(line.starts_with(prefix), "{line}");
    for raw in ['\n', '\r', '\x1b'] {
        assert!(!line.contains(raw), "{raw:?} reached the log: {line:?}");
    }
    assert!(line.contains("close confirmed"), "{line}");
}

#[test]
fn a_window_close_message_cannot_forge_a_second_log_line() {
    let lines = captured_logs(|| crate::app_setup::window_close_log(FORGED.to_string()));
    assert_one_escaped_line(&lines, "[WindowClose] ");
}

#[test]
fn an_update_message_cannot_forge_a_second_log_line() {
    let lines = captured_logs(|| crate::app_setup::update_log(FORGED.to_string()));
    assert_one_escaped_line(&lines, "[Update] ");
}

#[cfg(debug_assertions)]
#[test]
fn a_frontend_debug_message_cannot_forge_a_second_log_line() {
    let lines = captured_logs(|| crate::app_setup::debug_log(FORGED.to_string()));
    assert_one_escaped_line(&lines, "[Frontend] ");
}

#[test]
fn a_megabyte_frontend_message_costs_the_log_a_bounded_line() {
    let huge = "x".repeat(1024 * 1024);
    let lines = captured_logs(|| crate::app_setup::update_log(huge));
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].chars().count() < crate::peer_text::MAX_PEER_MESSAGE + 64,
        "{} characters reached the log",
        lines[0].chars().count()
    );
}

#[test]
fn an_ordinary_milestone_is_logged_whole() {
    let lines = captured_logs(|| {
        crate::app_setup::update_log("[check:returned] {\"found\":true}".to_string());
    });
    assert_eq!(
        lines,
        vec!["[Update] \"[check:returned] {\\\"found\\\":true}\"".to_string()]
    );
}

fn is_lowercase_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[test]
fn the_machine_id_is_a_64_char_lowercase_hex_digest() {
    let id = machine_id_hash();
    assert_eq!(id.len(), 64, "{id}");
    assert!(is_lowercase_hex(&id), "{id}");
}

#[test]
fn the_machine_id_is_stable_across_calls() {
    assert_eq!(machine_id_hash(), machine_id_hash());
}

#[test]
fn the_machine_id_is_the_documented_digest_of_prefix_host_os_and_arch() {
    // The recipe is the contract: the update server keys on this value, so
    // changing the prefix, the separators or an input silently re-identifies
    // every installation. Recomputed here from the documented inputs.
    let hostname = gethostname::gethostname().to_string_lossy().into_owned();
    let documented = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "vmark-machine-id-v1:{}:{}:{}",
                hostname,
                std::env::consts::OS,
                std::env::consts::ARCH
            )
            .as_bytes()
        )
    );
    assert_eq!(machine_id_hash(), documented);

    // Any other hostname under the same recipe yields a different id — the
    // "different inputs, different outputs" half, stated against the recipe.
    let other = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "vmark-machine-id-v1:{}-other:{}:{}",
                hostname,
                std::env::consts::OS,
                std::env::consts::ARCH
            )
            .as_bytes()
        )
    );
    assert_ne!(machine_id_hash(), other);
}

#[test]
fn the_machine_id_does_not_contain_the_raw_hostname() {
    let id = machine_id_hash();
    let hostname = gethostname::gethostname()
        .to_string_lossy()
        .to_ascii_lowercase();
    // A hostname that is itself short lowercase hex ("abc") could appear in a
    // 64-hex digest by chance; every real hostname with a non-hex character
    // or eight-plus characters cannot, so the assertion is meaningful there.
    if hostname.is_empty() || (hostname.len() < 8 && is_lowercase_hex(&hostname)) {
        return;
    }
    assert!(!id.contains(&hostname), "the raw hostname leaked into {id}");
}

/// Audit F2 #38/#39 — `setup_app` cannot run under MockRuntime: it builds the
/// native menu, deletes the legacy `~/.vmark` directory and installs default
/// genies into the real app-data folder. What decides whether a restored
/// session can read a folder before its grant is in is ORDER — the main window
/// exists already but cannot load or invoke until setup returns — so the order
/// is pinned against the source, as `workflow/guards.test.rs` pins its gate.
/// What `restore_at_launch` itself does is tested in `workspace::grants`.
#[test]
fn setup_restores_workspace_grants_before_anything_else_starts() {
    // A Windows checkout has CRLF line endings; the searches below assume LF.
    let source = include_str!("app_setup.rs").replace("\r\n", "\n");
    let start = source
        .find("pub(crate) fn setup_app(")
        .expect("setup_app exists");
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").expect("setup_app ends")];

    let restore = body
        .find("workspace::grants::restore_at_launch(")
        .expect("setup restores the recorded workspace grants");
    assert_eq!(
        body.matches("restore_at_launch(").count(),
        1,
        "exactly once"
    );
    for later in [
        "create_localized_menu(",
        "cleanup_legacy_home_dir(",
        "install_default_genies(",
        "file_open_state(",
        "log_runtime_state(",
        ".listen(",
    ] {
        let at = body
            .find(later)
            .unwrap_or_else(|| panic!("`{later}` left setup_app: re-derive this list"));
        assert!(
            restore < at,
            "`{later}` runs before the grants are restored"
        );
    }
}
