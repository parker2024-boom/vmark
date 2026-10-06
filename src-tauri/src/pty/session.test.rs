//! Tests for `session.rs` — `terminate` in both states a session can be in:
//! never started (no reader thread exists to notice anything) and started
//! (WI-RA6.1, WI-RA6.2). What may be spawned at all is `spawn_policy.rs`'s
//! business and is tested there.

use super::*;
use crate::pty::output::Chunk;
use crate::pty::test_support::{pid_gone, shell_pid, spawn_sh, start_sh};

#[test]
fn a_never_started_session_has_its_shell_killed_and_reaped() {
    let session = Arc::new(spawn_sh("doc-1", "sleep 600"));
    let pid = shell_pid(&session);
    assert!(!pid_gone(pid), "shell should be running before close");

    terminate(std::slice::from_ref(&session));

    assert!(session.shutdown.load(Ordering::Acquire));
    assert!(
        pid_gone(pid),
        "shell {pid} must be killed AND reaped (a zombie still has a pid entry)"
    );
}

#[test]
fn a_started_session_has_its_shell_reaped_and_its_reader_joined() {
    let running = start_sh("echo ready; sleep 600");

    terminate(std::slice::from_ref(&running.session));

    assert!(pid_gone(running.pid), "the shell must be killed and reaped");
    assert!(
        running.exit_code.lock().unwrap().is_some(),
        "the reader thread ran to its end before terminate returned"
    );
    assert_eq!(
        Arc::strong_count(&running.session),
        1,
        "the joined reader released its reference"
    );
}

#[test]
fn terminating_twice_is_a_no_op_the_second_time() {
    let running = start_sh("echo ready; sleep 600");
    terminate(std::slice::from_ref(&running.session));
    let code = running.session.child.try_reap();

    terminate(std::slice::from_ref(&running.session));

    assert_eq!(running.session.child.try_reap(), code);
}

#[test]
fn a_session_starts_its_reader_only_once() {
    let session = Arc::new(spawn_sh("doc-1", "sleep 600"));
    let drain = |_: Arc<Session>, mut source: OutputSource| {
        let mut buf = [0u8; 64];
        while let Ok(Chunk::Data(_)) = source.read(&mut buf) {}
    };

    assert!(session.start_reader("first".into(), drain).is_ok());
    assert!(matches!(
        session.start_reader("second".into(), drain),
        Err(StartError::AlreadyStarted)
    ));

    terminate(std::slice::from_ref(&session));
}

#[test]
fn a_reader_started_after_the_session_was_stopped_ends_at_once() {
    let session = Arc::new(spawn_sh("doc-1", "sleep 600"));
    terminate(std::slice::from_ref(&session));

    let (done, finished) = std::sync::mpsc::channel();
    session
        .start_reader("late".into(), move |session, source| {
            let code = crate::pty::reader::run_reader(0, &session, source, |_| true);
            let _ = done.send(code);
        })
        .unwrap_or_else(|_| panic!("start reader"));

    finished
        .recv_timeout(crate::pty::test_support::DEADLINE)
        .expect("a reader on a stopped session must not wait for output");
}
