//! WI-RA4.3 — the privileged install command reads nothing the user can write,
//! and its quoting cannot be broken out of.
//!
//! The commands are text, so they are tested the way root will use them: run
//! by `/bin/sh` (and, for the AppleScript layer, by `osascript`) — unprivileged
//! and against a temp directory. Only `with administrator privileges` itself
//! is left out.

use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const LAUNCHER: &str = "#!/bin/bash\n# launcher\nopen -b app.vmark \"$@\"\n";

/// Run a command the way `do shell script` does, returning its exit status.
fn sh(command: &str) -> i32 {
    crate::ai_provider::build_command("/bin/sh", &[])
        .arg("-c")
        .arg(command)
        .status()
        .expect("spawn /bin/sh")
        .code()
        .expect("exit status")
}

/// A fresh directory and the install target inside a not-yet-existing
/// subdirectory of it.
fn fresh_target() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("bin").join("vmark");
    (dir, target)
}

fn install(content: &str, target: &Path) -> i32 {
    sh(&install_command(
        content,
        target.parent().unwrap().to_str().unwrap(),
        target.to_str().unwrap(),
    ))
}

fn mode(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o7777
}

// ── shell_single_quote ──────────────────────────────────────────────────────

#[test]
fn shell_single_quote_plain_path() {
    assert_eq!(shell_single_quote("/usr/local/bin"), "'/usr/local/bin'");
}

#[test]
fn shell_single_quote_path_with_space() {
    assert_eq!(shell_single_quote("/tmp/with space"), "'/tmp/with space'");
}

#[test]
fn shell_single_quote_disarms_command_injection() {
    // A `;` that would end the path argument and start a command: quoted, it
    // and everything after it are literal text.
    let evil = "/tmp/foo;touch /tmp/pwned";
    assert_eq!(shell_single_quote(evil), "'/tmp/foo;touch /tmp/pwned'");
}

#[test]
fn shell_single_quote_handles_dollar_paren_and_backtick() {
    let evil = "/tmp/$(id)/`whoami`";
    assert_eq!(shell_single_quote(evil), "'/tmp/$(id)/`whoami`'");
}

#[test]
fn shell_single_quote_escapes_embedded_single_quote() {
    // POSIX idiom: close, escape, reopen — a single `'` inside the string
    // becomes `'\''` (close-quote, escaped-quote, reopen-quote).
    assert_eq!(shell_single_quote("/a/it's/b"), "'/a/it'\\''s/b'");
}

#[test]
fn shell_single_quote_escapes_multiple_single_quotes() {
    assert_eq!(shell_single_quote("a'b'c"), "'a'\\''b'\\''c'");
}

#[test]
fn shell_single_quote_empty_input() {
    assert_eq!(shell_single_quote(""), "''");
}

/// The property the install rests on: whatever the text, `/bin/sh` reads the
/// quoted form back as exactly that text, as one word.
#[test]
fn shell_single_quote_round_trips_any_text_through_sh() {
    for text in [
        "plain",
        "it's",
        "''''",
        "'; echo INJECTED; '",
        "\"; echo INJECTED; \"",
        "$(echo INJECTED) `echo INJECTED` $HOME ${PATH}",
        "back\\slash and trailing backslash \\",
        "line one\nline two\r\nline three\n",
        "tab\tand *glob* ? [x] ~ ! # & | ; < > ( ) { }",
        "%s %d %% \\n \\x41",
        "-n -e --",
        "中文 — 日本語 🙂",
        "",
    ] {
        let output = crate::ai_provider::build_command("/bin/sh", &[])
            .arg("-c")
            .arg(format!("printf '%s' {}", shell_single_quote(text)))
            .output()
            .expect("spawn /bin/sh");
        assert!(output.status.success(), "{text:?}");
        assert_eq!(output.stdout, text.as_bytes(), "{text:?}");
    }
}

// ── install_command ─────────────────────────────────────────────────────────

#[test]
fn installs_the_launcher_byte_for_byte_as_an_executable() {
    let (_dir, target) = fresh_target();
    assert_eq!(install(LAUNCHER, &target), 0);
    assert_eq!(
        std::fs::read(&target).expect("installed"),
        LAUNCHER.as_bytes()
    );
    assert_eq!(mode(&target), 0o755);
}

/// Content cannot break out of its literal: each of these would run `touch`
/// on the marker if the quoting let it.
#[test]
fn content_that_tries_to_break_out_of_the_quoting_is_installed_as_text() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("pwned");
    let touch = format!("touch '{}'", marker.to_str().unwrap());
    for content in [
        format!("'; {touch}; '"),
        format!("'\n{touch}\n'"),
        format!("\"; {touch}; \""),
        format!("$({touch})"),
        format!("`{touch}`"),
        format!("'\\''; {touch}; '\\''"),
        format!("\\'; {touch}; \\'"),
        format!("x' > /dev/null; {touch}; printf '%s' 'y"),
        "it's a launcher \\ with a trailing backslash \\".to_string(),
        "no trailing newline".to_string(),
        "%s %d %%\n".to_string(),
        "中文 — 🙂\r\n".to_string(),
        String::new(),
    ] {
        let (_dir, target) = fresh_target();
        assert_eq!(install(&content, &target), 0, "{content:?}");
        assert_eq!(
            std::fs::read(&target).expect("installed"),
            content.as_bytes(),
            "{content:?}"
        );
        assert!(!marker.exists(), "{content:?} ran as a command");
    }
}

#[test]
fn a_target_path_full_of_shell_syntax_is_just_a_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir
        .path()
        .join("it's a \"dir\" $(id) `id` ; &")
        .join("vmark");
    assert_eq!(install(LAUNCHER, &target), 0);
    assert_eq!(
        std::fs::read(&target).expect("installed"),
        LAUNCHER.as_bytes()
    );
}

#[test]
fn an_existing_file_at_the_target_is_refused_and_left_untouched() {
    let (_dir, target) = fresh_target();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "someone else's vmark\n").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();

    assert_eq!(install(LAUNCHER, &target), EXIT_TARGET_EXISTS);

    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "someone else's vmark\n"
    );
    assert_eq!(mode(&target), 0o600);
}

/// A link planted at the target is never written through and never
/// `chmod`ed through — the old flow's `chmod 755` followed it.
#[test]
fn a_link_at_the_target_is_refused_and_what_it_points_at_is_untouched() {
    let (dir, target) = fresh_target();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let victim = dir.path().join("victim");
    std::fs::write(&victim, "private\n").unwrap();
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::os::unix::fs::symlink(&victim, &target).unwrap();

    assert_eq!(install(LAUNCHER, &target), EXIT_TARGET_EXISTS);

    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "private\n");
    assert_eq!(
        mode(&victim),
        0o600,
        "the link's target must not be chmod-ed"
    );
    assert!(std::fs::symlink_metadata(&target)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn a_dangling_link_at_the_target_is_refused_and_nothing_is_created_behind_it() {
    let (dir, target) = fresh_target();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let nowhere = dir.path().join("not-there-yet");
    std::os::unix::fs::symlink(&nowhere, &target).unwrap();

    assert_eq!(install(LAUNCHER, &target), EXIT_TARGET_EXISTS);

    assert!(!nowhere.exists(), "the write went through the link");
}

/// What the shell does when the file it wrote is not what it was told to
/// write: remove it and fail. Driven by handing the verification a different
/// literal than the write.
#[test]
fn a_file_that_does_not_match_after_the_write_is_removed() {
    let (_dir, target) = fresh_target();
    let command = install_script(
        "what was written\n",
        LAUNCHER,
        target.parent().unwrap().to_str().unwrap(),
        target.to_str().unwrap(),
    );

    assert_eq!(sh(&command), EXIT_MISMATCH);

    assert!(
        std::fs::symlink_metadata(&target).is_err(),
        "an unverified file was left installed"
    );
}

#[test]
fn uninstall_removes_exactly_the_target() {
    let (_dir, target) = fresh_target();
    assert_eq!(install(LAUNCHER, &target), 0);
    let sibling = target.with_file_name("other");
    std::fs::write(&sibling, "keep").unwrap();

    assert_eq!(sh(&uninstall_command(target.to_str().unwrap())), 0);

    assert!(!target.exists());
    assert!(sibling.exists());
}

// ── the AppleScript layer ───────────────────────────────────────────────────

/// Run `shell_cmd` through `osascript` exactly as the install does, minus the
/// administrator prompt.
fn osascript(shell_cmd: &str) -> std::process::Output {
    crate::ai_provider::build_command("/usr/bin/osascript", &[])
        .arg("-e")
        .arg(apple_script(shell_cmd, false))
        .output()
        .expect("spawn osascript")
}

#[test]
fn the_privileged_script_differs_only_by_asking_for_administrator_rights() {
    assert_eq!(
        apple_script("echo hi", true),
        format!(
            "{} with administrator privileges",
            apple_script("echo hi", false)
        )
    );
    assert_eq!(
        apple_script("printf '%s' \"a\\b\"", false),
        "do shell script \"printf '%s' \\\"a\\\\b\\\"\""
    );
}

/// The whole path short of the password prompt: Rust → AppleScript string →
/// `/bin/sh` → file. Line breaks, quotes of both kinds, backslashes and
/// non-ASCII text all have to survive two layers of quoting.
#[test]
fn the_install_command_survives_the_applescript_layer_byte_for_byte() {
    let content = "#!/bin/bash\n# VMark CLI launcher — it's \"quoted\" \\ $HOME `id`\nopen -b app.vmark \"$@\"\n";
    let (_dir, target) = fresh_target();
    let output = osascript(&install_command(
        content,
        target.parent().unwrap().to_str().unwrap(),
        target.to_str().unwrap(),
    ));
    assert!(
        output.status.success(),
        "osascript failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(&target).expect("installed"),
        content.as_bytes()
    );
    assert_eq!(mode(&target), 0o755);
}

/// `osascript` reports the shell's exit status in its error line, which is
/// how a refusal inside the privileged shell gets back to Rust.
#[test]
fn a_refusal_inside_the_shell_is_readable_from_osascript() {
    let (_dir, target) = fresh_target();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "someone else's vmark\n").unwrap();

    let output = osascript(&install_command(
        LAUNCHER,
        target.parent().unwrap().to_str().unwrap(),
        target.to_str().unwrap(),
    ));

    assert!(!output.status.success());
    assert_eq!(
        shell_exit_status(&String::from_utf8_lossy(&output.stderr)),
        Some(EXIT_TARGET_EXISTS)
    );
}

#[test]
fn shell_exit_status_reads_the_trailing_number() {
    for (stderr, expected) in [
        (
            "0:24: execution error: The command exited with a non-zero status. (3)\n",
            Some(3),
        ),
        ("0:39: execution error: boom (4)", Some(4)),
        ("0:70: execution error: User canceled. (-128)\n", Some(-128)),
        ("execution error: a (weird) message (12)\n", Some(12)),
        ("no status here", None),
        ("unbalanced (3", None),
        ("not a number (abc)", None),
        ("", None),
    ] {
        assert_eq!(shell_exit_status(stderr), expected, "{stderr:?}");
    }
}
