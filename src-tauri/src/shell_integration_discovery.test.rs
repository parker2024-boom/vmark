//! WI-RA4.2 — `prepare_shell_integration` runs only a shell VMark discovered.
//!
//! The command's `shell` comes from the webview, and for zsh the command runs
//! it (`<shell> -lic …`). These tests pin that a path VMark did not discover
//! is refused BEFORE anything is executed or written, however it is spelled,
//! and that a discovered shell still gets its integration.

use super::*;

fn discovered(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|p| (*p).to_string()).collect()
}

// ── the comparison ──────────────────────────────────────────────────────────

#[test]
fn a_discovered_shell_is_accepted_exactly_as_vmark_spelled_it() {
    let known = discovered(&["/bin/zsh", "/opt/homebrew/bin/bash", "/Users/张三/bin/zsh"]);
    for shell in ["/bin/zsh", "/opt/homebrew/bin/bash", "/Users/张三/bin/zsh"] {
        assert_eq!(require_discovered_shell(shell, &known), Ok(()), "{shell}");
    }
}

#[test]
fn any_other_spelling_of_a_shell_is_refused() {
    let known = discovered(&["/bin/zsh", "/bin/bash"]);
    for shell in [
        "/tmp/planted/zsh",    // same file name, a file VMark never found
        "/bin/../bin/zsh",     // parent-directory detour to a discovered shell
        "/bin//zsh",           // doubled separator
        "/bin/zsh/",           // trailing separator
        "/bin/./zsh",          // current-directory detour
        "/BIN/ZSH",            // another case of the same name
        "zsh",                 // bare name, resolved against PATH
        "bin/zsh",             // relative path
        "/bin/zsh ",           // trailing whitespace
        "/bin/zsh\0/bin/bash", // embedded NUL
        "",                    // nothing at all
    ] {
        let refused = require_discovered_shell(shell, &known);
        assert!(refused.is_err(), "{shell:?} must be refused");
    }
}

#[test]
fn nothing_is_accepted_when_no_shell_was_discovered() {
    assert!(require_discovered_shell("/bin/zsh", &[]).is_err());
}

#[test]
fn the_refusal_names_the_shell_it_refused() {
    let error = require_discovered_shell("/tmp/planted/zsh", &discovered(&["/bin/zsh"]))
        .expect_err("refused");
    assert!(error.contains("/tmp/planted/zsh"), "{error}");
}

/// The allowlist is what VMark itself offers: every shell Settings lists, and
/// the default the terminal falls back to.
#[test]
fn discovered_shells_are_the_listed_shells_plus_the_default() {
    let shells = discovered_shells();
    for listed in crate::shell_env::available_shells() {
        assert!(shells.contains(&listed), "{listed} is offered in Settings");
    }
    let default = crate::shell_env::default_shell();
    assert!(shells.contains(&default), "{default} is the default shell");
}

// ── nothing runs for a shell that was not discovered ────────────────────────

/// A stand-in shell named `name` that records being run by creating a marker
/// file. Returns the directory guard, the shell's path and the marker's path.
#[cfg(unix)]
fn recording_shell(name: &str) -> (tempfile::TempDir, String, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("tempdir");
    let marker = dir.path().join("was-run");
    let shell = dir.path().join(name);
    std::fs::write(
        &shell,
        format!(
            "#!/bin/sh\n: > '{}'\n",
            marker.to_str().expect("utf-8 path")
        ),
    )
    .expect("write stand-in shell");
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (dir, shell.to_str().expect("utf-8 path").to_string(), marker)
}

/// Every entry under `dir`, however deep — empty when nothing was written.
#[cfg(unix)]
fn entries_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("read_dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path.clone());
            }
            found.push(path);
        }
    }
    found
}

#[cfg(unix)]
#[test]
fn a_file_merely_named_zsh_is_refused_before_it_is_run_or_anything_is_written() {
    let (_dir, planted, marker) = recording_shell("zsh");
    let data = tempfile::tempdir().expect("tempdir");

    let result = prepare_with(
        &planted,
        || discovered(&["/bin/zsh", "/bin/bash"]),
        || Ok(data.path().to_path_buf()),
    );

    assert!(result.is_err(), "an undiscovered zsh must be refused");
    assert!(!marker.exists(), "the planted file was executed");
    assert_eq!(
        entries_under(data.path()),
        Vec::<PathBuf>::new(),
        "a refusal must write nothing"
    );
}

/// A symlink to a discovered shell is still a path VMark did not discover.
#[cfg(unix)]
#[test]
fn a_symlink_to_a_discovered_shell_is_refused() {
    let (_dir, real, marker) = recording_shell("zsh");
    let links = tempfile::tempdir().expect("tempdir");
    let link = links.path().join("zsh");
    std::os::unix::fs::symlink(&real, &link).expect("symlink");
    let data = tempfile::tempdir().expect("tempdir");

    let result = prepare_with(
        link.to_str().expect("utf-8 path"),
        || vec![real.clone()],
        || Ok(data.path().to_path_buf()),
    );

    assert!(
        result.is_err(),
        "a link to a discovered shell must be refused"
    );
    assert!(!marker.exists(), "the shell behind the link was executed");
}

#[cfg(unix)]
#[test]
fn a_discovered_zsh_is_probed_and_gets_its_integration() {
    let (_dir, zsh, marker) = recording_shell("zsh");
    let data = tempfile::tempdir().expect("tempdir");

    let integration = prepare_with(&zsh, || vec![zsh.clone()], || Ok(data.path().to_path_buf()))
        .expect("a discovered shell is prepared")
        .expect("zsh has an integration");

    let rc_dir = data.path().join("shell-integration").join("zsh");
    assert_eq!(
        integration.env.get("ZDOTDIR").map(String::as_str),
        rc_dir.to_str()
    );
    assert_eq!(integration.args, Vec::<String>::new());
    assert_eq!(
        std::fs::read_to_string(rc_dir.join(".zshrc")).expect("rc written"),
        ZSH_INTEGRATION
    );
    assert!(marker.exists(), "the ZDOTDIR probe runs the discovered zsh");
}

#[cfg(unix)]
#[test]
fn a_discovered_bash_gets_its_rcfile_and_is_not_run() {
    let (_dir, bash, marker) = recording_shell("bash");
    let data = tempfile::tempdir().expect("tempdir");

    let integration = prepare_with(
        &bash,
        || vec![bash.clone()],
        || Ok(data.path().to_path_buf()),
    )
    .expect("a discovered shell is prepared")
    .expect("bash has an integration");

    let rc = data.path().join("shell-integration/bash/vmark.bash");
    assert_eq!(
        integration.args,
        vec![
            "--rcfile".to_string(),
            rc.to_str().expect("utf-8").to_string()
        ]
    );
    assert!(rc.is_file());
    assert!(
        !marker.exists(),
        "bash needs no probe, so it is never run here"
    );
}

/// A shell VMark cannot instrument is answered `None` without looking up the
/// discovered shells or the data directory at all.
#[test]
fn an_unsupported_shell_costs_no_lookup() {
    for shell in [
        "/usr/local/bin/fish",
        "/bin/sh",
        r"C:\Windows\System32\cmd.exe",
        "",
    ] {
        let result = prepare_with(
            shell,
            || panic!("the shell list must not be consulted for {shell:?}"),
            || panic!("the data directory must not be resolved for {shell:?}"),
        );
        assert_eq!(result, Ok(None), "{shell:?}");
    }
}
