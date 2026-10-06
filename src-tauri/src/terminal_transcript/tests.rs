//! WI-TP1.1: preserve existing hooks; refuse arbitrary file reads.
//! WI-RA6.4: one token encoding; a binding to a FIFO is refused, not opened.
//! WI-RA6.5: a read that carries a cursor gets only what was appended.
use super::*;
#[test]
fn merges_hooks_without_destroying_settings() {
    let mut config = serde_json::json!({"theme":"dark", "hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing"}]}]}});
    assert!(add_hook(&mut config, "node '/preview.cjs'").unwrap());
    assert!(
        !add_hook(&mut config, "node '/preview.cjs'").unwrap(),
        "second add is a no-op"
    );
    assert_eq!(config["theme"], "dark");
    assert_eq!(config["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
    assert_eq!(
        config["hooks"]["SessionStart"][0]["hooks"][0]["command"],
        "existing"
    );
}
#[test]
fn invalid_hook_config_is_not_overwritten() {
    assert!(add_hook(&mut serde_json::json!({"hooks":false}), "test").is_err());
}
#[test]
fn tokens_are_opaque_uuids() {
    assert!(valid_token("cb28fc00-2c1b-4eaf-9d09-71d9d5392926"));
    assert!(valid_token(&terminal_transcript_prepare()));
    assert!(!valid_token("../secret"));
    assert!(!valid_token(""));
}
#[test]
fn a_token_is_accepted_only_in_the_encoding_vmark_issues() {
    // Every one of these names the same UUID as the accepted form above, and
    // each would name a DIFFERENT binding file.
    for other in [
        "CB28FC00-2C1B-4EAF-9D09-71D9D5392926",
        "cb28fc002c1b4eaf9d0971d9d5392926",
        "{cb28fc00-2c1b-4eaf-9d09-71d9d5392926}",
        "urn:uuid:cb28fc00-2c1b-4eaf-9d09-71d9d5392926",
        " cb28fc00-2c1b-4eaf-9d09-71d9d5392926",
        "cb28fc00-2c1b-4eaf-9d09-71d9d5392926\n",
    ] {
        assert!(!valid_token(other), "{other:?}");
    }
    // Thirty-six characters the hook's own pattern lets through.
    assert!(!valid_token("------------------------------------"));
    assert!(!valid_token("cb28fc002c1b4eaf9d0971d9d5392926abcd"));
    assert!(!valid_token("令牌令牌令牌令牌令牌令牌"));
}
#[test]
fn canonical_paths_are_confined_to_session_roots() {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    let transcript = root.join("test.jsonl");
    std::fs::write(&transcript, b"{}\n").unwrap();
    assert!(allowed_path(
        &transcript.canonicalize().unwrap(),
        std::slice::from_ref(&root)
    ));
    assert!(!allowed_path(
        Path::new("/etc/passwd"),
        std::slice::from_ref(&root)
    ));
    assert!(!allowed_path(
        &root.join("test.json"),
        std::slice::from_ref(&root)
    ));
    std::fs::remove_dir_all(root).unwrap();
}
fn snapshot_fixture() -> (PathBuf, PathBuf, String) {
    let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&base).unwrap();
    // Canonical, so the macOS /var -> /private/var link does not defeat confinement.
    let base = base.canonicalize().unwrap();
    let root = base.join("bindings");
    let sessions = base.join("sessions");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(root.join("enabled"), b"enabled").unwrap();
    (root, sessions, uuid::Uuid::new_v4().to_string())
}
fn bind(root: &Path, token: &str, transcript: &Path) {
    let binding = serde_json::json!({"path": transcript, "sessionId": "s"});
    std::fs::write(root.join(format!("{token}.json")), binding.to_string()).unwrap();
}
#[test]
fn snapshot_waits_until_enabled_bound_and_written() {
    let (root, sessions, token) = snapshot_fixture();
    let roots = [sessions.clone()];
    assert!(read_snapshot(&root, &roots, &token, None)
        .unwrap()
        .is_none());
    // The CLI announces its transcript before creating it.
    let transcript = sessions.join("t.jsonl");
    bind(&root, &token, &transcript);
    assert!(read_snapshot(&root, &roots, &token, None)
        .unwrap()
        .is_none());
    std::fs::write(&transcript, b"{\"a\":1}\n").unwrap();
    let first = read_snapshot(&root, &roots, &token, None).unwrap().unwrap();
    assert!(first.reset, "the first answer is a fresh tail");
    assert_eq!(first.data, "{\"a\":1}\n");
    let same = read_snapshot(&root, &roots, &token, Some(&first.cursor))
        .unwrap()
        .unwrap();
    assert!(
        !same.reset && same.data.is_empty(),
        "nothing new, nothing sent"
    );
    assert_eq!(same.cursor, first.cursor);
    std::fs::remove_file(root.join("enabled")).unwrap();
    assert!(read_snapshot(&root, &roots, &token, None)
        .unwrap()
        .is_none());
    std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
}
#[test]
fn a_read_that_carries_a_cursor_gets_only_what_was_appended() {
    let (root, sessions, token) = snapshot_fixture();
    let roots = [sessions.clone()];
    let transcript = sessions.join("t.jsonl");
    bind(&root, &token, &transcript);
    std::fs::write(&transcript, "{\"n\":1}\n{\"n\":2}\n").unwrap();
    let first = read_snapshot(&root, &roots, &token, None).unwrap().unwrap();
    assert_eq!(first.data, "{\"n\":1}\n{\"n\":2}\n");

    std::fs::write(&transcript, "{\"n\":1}\n{\"n\":2}\n{\"n\":\"三\"}\n").unwrap();
    let second = read_snapshot(&root, &roots, &token, Some(&first.cursor))
        .unwrap()
        .unwrap();

    assert!(!second.reset);
    assert_eq!(second.data, "{\"n\":\"三\"}\n");
    std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
}
#[test]
fn a_binding_that_moves_to_another_transcript_starts_over() {
    let (root, sessions, token) = snapshot_fixture();
    let roots = [sessions.clone()];
    let (old, new) = (sessions.join("old.jsonl"), sessions.join("new.jsonl"));
    std::fs::write(&old, "old-1\nold-2\n").unwrap();
    std::fs::write(&new, "new-1\nnew-2\nnew-3\n").unwrap();
    bind(&root, &token, &old);
    let first = read_snapshot(&root, &roots, &token, None).unwrap().unwrap();

    // The CLI in this shell was restarted: same token, another transcript.
    bind(&root, &token, &new);
    let second = read_snapshot(&root, &roots, &token, Some(&first.cursor))
        .unwrap()
        .unwrap();

    assert!(
        second.reset,
        "a cursor for another file must not be resumed"
    );
    assert_eq!(second.data, "new-1\nnew-2\nnew-3\n");
    std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
}
#[test]
fn snapshot_refuses_transcripts_outside_session_roots() {
    let (root, sessions, token) = snapshot_fixture();
    let outside = root.parent().unwrap().join("secret.jsonl");
    std::fs::write(&outside, b"{}\n").unwrap();
    bind(&root, &token, &outside);
    let err = read_snapshot(&root, &[sessions], &token, None)
        .err()
        .unwrap();
    assert!(format!("{err:?}").contains("outside"));
    std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
}
#[test]
fn forgetting_and_disabling_remove_bindings_only() {
    let (root, sessions, token) = snapshot_fixture();
    bind(&root, &token, &sessions.join("t.jsonl"));
    remove_binding(&root, &token).unwrap();
    remove_binding(&root, &token).unwrap(); // idempotent
    assert!(!root.join(format!("{token}.json")).exists());
    bind(&root, &token, &sessions.join("t.jsonl"));
    std::fs::write(root.join("unrelated.json"), b"{}").unwrap();
    configure(&root, false, &root.join("claude"), &root.join("codex")).unwrap();
    assert!(!root.join(format!("{token}.json")).exists());
    assert!(!root.join("enabled").exists());
    assert!(root.join("unrelated.json").exists());
    std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
}
#[test]
fn enabling_leaves_already_configured_cli_files_untouched() {
    let (root, _sessions, _token) = snapshot_fixture();
    let base = root.parent().unwrap().to_path_buf();
    let (claude, codex) = (base.join("claude"), base.join("codex"));
    configure(&root, true, &claude, &codex).unwrap();
    let settings = claude.join("settings.json");
    let hooks = codex.join("hooks.json");
    assert!(std::fs::read_to_string(&settings)
        .unwrap()
        .contains("terminal-transcript-hook.cjs"));
    // Rewrite both compactly: a second enable must not reformat (i.e. rewrite) them.
    for path in [&settings, &hooks] {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let before = (
        std::fs::read(&settings).unwrap(),
        std::fs::read(&hooks).unwrap(),
    );
    configure(&root, true, &claude, &codex).unwrap();
    assert_eq!(
        before,
        (
            std::fs::read(&settings).unwrap(),
            std::fs::read(&hooks).unwrap()
        )
    );
    std::fs::remove_dir_all(base).unwrap();
}
#[cfg(unix)]
#[test]
fn a_binding_to_a_fifo_is_refused_without_blocking_a_thread() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    let (root, sessions, token) = snapshot_fixture();
    let fifo = sessions.join("t.jsonl");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: `name` is a valid NUL-terminated path for the whole call.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
    bind(&root, &token, &fifo);

    // Opening a FIFO for reading waits for a writer, so the read runs on its
    // own thread and has to answer within the deadline.
    let (done, answer) = std::sync::mpsc::channel();
    let (thread_root, thread_roots) = (root.clone(), [sessions.clone()]);
    std::thread::spawn(move || {
        let outcome = read_snapshot(&thread_root, &thread_roots, &token, None);
        let _ = done.send(outcome.map(|_| ()).map_err(|error| error.to_string()));
    });
    let answer = answer.recv_timeout(std::time::Duration::from_secs(10));
    // Release a reader that did block, so a failing run leaves no thread behind.
    let _unblock = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo);

    let error = answer
        .expect("a FIFO must be refused, not opened")
        .expect_err("a FIFO is not a transcript");
    assert!(error.contains("regular file"), "{error}");
    std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
}
