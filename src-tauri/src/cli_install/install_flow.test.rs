//! WI-RA4.3 — the install flow, end to end, with `/bin/sh` standing in for
//! the administrator shell.
//!
//! `install_at` takes its target and its privileged runner as arguments, so
//! these tests run the real commands against a temp directory: nothing the
//! user can write is read by the privileged step, an entry that appears at
//! the target is refused, and a file that fails verification does not stay
//! installed.

use super::*;
use std::cell::RefCell;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

// ── the install flow, with /bin/sh as the administrator shell ───────────────

/// A fresh directory and an install target in a subdirectory that does not
/// exist yet (the privileged command creates it).
fn fresh_target() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("bin").join("vmark");
    (dir, target)
}

/// What the administrator shell does with a command, minus the privileges:
/// run it with `/bin/sh`, and report a failure the way `osascript` words one.
fn sh_as_admin(command: &str) -> Result<(), CliInstallError> {
    let status = crate::ai_provider::build_command("/bin/sh", &[])
        .arg("-c")
        .arg(command)
        .status()
        .expect("spawn /bin/sh");
    match status.code() {
        Some(0) => Ok(()),
        code => Err(classify_failure(&format!(
            "0:1: execution error: The command exited with a non-zero status. ({})",
            code.unwrap_or(-1)
        ))),
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o7777
}

#[test]
fn install_writes_the_script_as_an_executable_and_reports_installed() {
    let (_dir, target) = fresh_target();

    assert_eq!(
        install_at(&target, &sh_as_admin),
        Ok(CliCommandOutcome::Installed)
    );

    assert_eq!(std::fs::read_to_string(&target).unwrap(), SCRIPT_CONTENT);
    assert_eq!(mode(&target), 0o755);
    let status = status_at(&target);
    assert!(status.installed && !status.foreign);
}

#[test]
fn installing_twice_does_not_ask_for_privileges_again() {
    let (_dir, target) = fresh_target();
    install_at(&target, &sh_as_admin).expect("first install");

    let never = |_: &str| -> Result<(), CliInstallError> {
        panic!("an installed command must not reach the administrator shell")
    };
    assert_eq!(
        install_at(&target, &never),
        Ok(CliCommandOutcome::AlreadyInstalled)
    );
}

#[test]
fn a_foreign_file_is_reported_without_asking_for_privileges() {
    let (_dir, target) = fresh_target();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "#!/bin/sh\necho someone else's vmark\n").unwrap();

    let never = |_: &str| -> Result<(), CliInstallError> {
        panic!("a foreign file must not reach the administrator shell")
    };
    assert_eq!(
        install_at(&target, &never),
        Err(CliInstallError::ForeignFile.to_string())
    );
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("someone else"));
}

/// The finding: the script used to be written unprivileged to
/// `$TMPDIR/vmark-cli-install.tmp` and moved into place by root after the
/// password dialog. Whatever sat at that path when the dialog closed was
/// installed. Here it is swapped at exactly that moment — and must be ignored.
#[test]
fn nothing_in_the_temp_directory_is_installed_even_if_swapped_during_the_dialog() {
    let (_dir, target) = fresh_target();
    let planted = std::env::temp_dir().join("vmark-cli-install.tmp");
    let attacker = "#!/bin/sh\necho attacker-controlled\n";

    let swap_then_run = |command: &str| -> Result<(), CliInstallError> {
        std::fs::write(&planted, attacker).expect("plant the temp file");
        sh_as_admin(command)
    };
    let result = install_at(&target, &swap_then_run);
    let installed = std::fs::read_to_string(&target).unwrap_or_default();
    let planted_after = std::fs::read_to_string(&planted).unwrap_or_default();
    let _ = std::fs::remove_file(&planted);

    assert_ne!(installed, attacker, "the swapped temp file was installed");
    assert_eq!(result, Ok(CliCommandOutcome::Installed));
    assert_eq!(installed, SCRIPT_CONTENT);
    assert_eq!(
        planted_after, attacker,
        "the temp file must not be consumed"
    );
}

/// A file that is not the script after the privileged step must not stay on
/// the user's PATH: it is removed, and the install fails.
#[test]
fn a_file_that_fails_verification_is_removed_not_left_installed() {
    let (_dir, target) = fresh_target();
    let replaced_after_the_shell = |command: &str| -> Result<(), CliInstallError> {
        sh_as_admin(command)?;
        std::fs::write(&target, "#!/bin/sh\necho swapped after the install\n").unwrap();
        Ok(())
    };

    let error = install_at(&target, &replaced_after_the_shell).expect_err("mismatch");

    assert_eq!(error, rust_i18n::t!("errors.cli.mismatch"));
    assert!(
        std::fs::symlink_metadata(&target).is_err(),
        "the unverified file was left installed"
    );
}

/// A link swapped in after the privileged step is a mismatch too, and removing
/// it must not touch what it points at.
#[test]
fn a_link_swapped_in_after_the_install_is_removed_without_following_it() {
    let (dir, target) = fresh_target();
    let elsewhere = dir.path().join("elsewhere");
    std::fs::write(&elsewhere, SCRIPT_CONTENT).unwrap();
    let swap_for_a_link = |command: &str| -> Result<(), CliInstallError> {
        sh_as_admin(command)?;
        std::fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &target).unwrap();
        Ok(())
    };

    let error = install_at(&target, &swap_for_a_link).expect_err("a link is not the script");

    assert_eq!(error, rust_i18n::t!("errors.cli.mismatch"));
    assert!(
        std::fs::symlink_metadata(&target).is_err(),
        "the link was left"
    );
    assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), SCRIPT_CONTENT);
}

/// When the unverified file cannot be removed, the error says so and names it,
/// rather than claiming a removal that did not happen.
#[test]
fn a_mismatch_that_cannot_be_removed_says_the_file_is_still_there() {
    let (_dir, target) = fresh_target();
    let parent = target.parent().unwrap().to_path_buf();
    let commands = RefCell::new(Vec::<String>::new());
    let replace_and_lock = |command: &str| -> Result<(), CliInstallError> {
        commands.borrow_mut().push(command.to_string());
        if commands.borrow().len() == 1 {
            sh_as_admin(command)?;
            std::fs::write(&target, "not the script\n").unwrap();
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).unwrap();
            Ok(())
        } else {
            sh_as_admin(command)
        }
    };

    let error = install_at(&target, &replace_and_lock).expect_err("mismatch");
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(
        error,
        rust_i18n::t!("errors.cli.mismatchNotRemoved", path = target.display())
    );
    assert_eq!(
        commands.borrow().len(),
        2,
        "removal must be retried through the administrator shell"
    );
    assert!(
        target.exists(),
        "this test's premise: the file could not be removed"
    );
}

#[test]
fn nothing_is_installed_when_the_password_dialog_is_cancelled() {
    let (_dir, target) = fresh_target();
    let cancelled = |_: &str| -> Result<(), CliInstallError> { Err(CliInstallError::Cancelled) };

    assert_eq!(
        install_at(&target, &cancelled),
        Err(CliInstallError::Cancelled.to_string())
    );
    assert!(!target.exists());
    assert!(
        !target.parent().unwrap().exists(),
        "nothing at all was created"
    );
}

/// An entry that appears at the target while the password dialog is open is
/// the privileged shell's to refuse; it is reported as a foreign file and
/// left alone.
#[test]
fn a_file_that_appears_during_the_dialog_is_refused_and_left_alone() {
    let (_dir, target) = fresh_target();
    let appear_then_run = |command: &str| -> Result<(), CliInstallError> {
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "appeared during the dialog\n").unwrap();
        sh_as_admin(command)
    };

    assert_eq!(
        install_at(&target, &appear_then_run),
        Err(CliInstallError::ForeignFile.to_string())
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "appeared during the dialog\n"
    );
}

// ── classify_failure ────────────────────────────────────────────────────────

#[test]
fn a_closed_password_dialog_is_a_cancellation() {
    assert_eq!(
        classify_failure("0:70: execution error: User canceled. (-128)\n"),
        CliInstallError::Cancelled
    );
}

#[test]
fn the_install_commands_refusals_map_to_their_own_errors() {
    assert_eq!(
        classify_failure("0:9: execution error: The command exited with a non-zero status. (3)"),
        CliInstallError::ForeignFile
    );
    assert_eq!(
        classify_failure("0:9: execution error: The command exited with a non-zero status. (4)"),
        CliInstallError::Failed(rust_i18n::t!("errors.cli.mismatch").to_string())
    );
}

#[test]
fn any_other_failure_is_reported_verbatim() {
    assert_eq!(
        classify_failure("0:9: execution error: mkdir: /usr/local: Read-only file system (1)\n"),
        CliInstallError::Failed(
            "0:9: execution error: mkdir: /usr/local: Read-only file system (1)".to_string()
        )
    );
}
