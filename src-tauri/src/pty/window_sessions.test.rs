//! Tests for `window_sessions.rs` — a destroyed window's PTY sessions are
//! removed from the map and their children killed, and no other window's
//! sessions are touched.

use super::*;
use crate::pty::test_support::{pid_gone, shell_pid, spawn_sh};

fn sleeping_session_owned_by(owner: &str) -> Session {
    spawn_sh(owner, "sleep 600")
}

fn state_with(sessions: Vec<Session>) -> PtyState {
    let state = PtyState::default();
    {
        let mut map = state.sessions.blocking_write();
        for (i, session) in sessions.into_iter().enumerate() {
            map.insert(i as u32 + 1, Arc::new(session));
        }
    }
    state
}

fn all_sessions(state: &PtyState) -> Vec<Arc<Session>> {
    state.sessions.blocking_read().values().cloned().collect()
}

#[test]
fn take_window_sessions_removes_only_the_destroyed_windows_sessions() {
    let state = state_with(vec![
        sleeping_session_owned_by("doc-1"),
        sleeping_session_owned_by("doc-2"),
        sleeping_session_owned_by("doc-1"),
    ]);

    let taken = take_window_sessions(&state, "doc-1");

    let mut taken_pids: Vec<u32> = taken.iter().map(|(pid, _)| *pid).collect();
    taken_pids.sort_unstable();
    assert_eq!(taken_pids, vec![1, 3]);
    let remaining: Vec<u32> = state.sessions.blocking_read().keys().copied().collect();
    assert_eq!(remaining, vec![2], "another window's session must survive");

    let taken: Vec<Arc<Session>> = taken.into_iter().map(|(_, session)| session).collect();
    terminate(&taken);
    terminate(&all_sessions(&state));
}

#[test]
fn take_window_sessions_is_a_noop_for_a_window_without_terminals() {
    let state = state_with(vec![sleeping_session_owned_by("doc-1")]);
    assert!(take_window_sessions(&state, "settings").is_empty());
    assert_eq!(state.sessions.blocking_read().len(), 1);
    terminate(&all_sessions(&state));
}

#[test]
fn a_destroyed_windows_shells_are_killed_and_another_windows_left_running() {
    let state = state_with(vec![
        sleeping_session_owned_by("doc-1"),
        sleeping_session_owned_by("doc-2"),
    ]);
    let pids: Vec<u32> = all_sessions(&state)
        .iter()
        .map(|session| shell_pid(session))
        .collect();

    let taken: Vec<Arc<Session>> = take_window_sessions(&state, "doc-1")
        .into_iter()
        .map(|(_, session)| session)
        .collect();
    terminate(&taken);

    assert!(pid_gone(pids[0]), "the destroyed window's shell is reaped");
    assert!(!pid_gone(pids[1]), "the other window's shell keeps running");
    terminate(&all_sessions(&state));
    assert!(pid_gone(pids[1]));
}
