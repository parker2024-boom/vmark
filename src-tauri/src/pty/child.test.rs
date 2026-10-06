// WI-RA6.1 — the escalating stop: a hangup the shell may act on, a bounded
//   grace, then a kill it cannot ignore, and a reap either way. Signals reach
//   the shell's process group and nothing outside it, and never a pid that has
//   already been reaped.

use super::*;
use crate::pty::test_support::{group_gone, pid_gone, start_sh, wait_until, Running};

const SHORT_GRACE: Duration = Duration::from_millis(200);
/// Long enough that a shell acting on the hangup always makes it.
const LONG_GRACE: Duration = Duration::from_secs(10);

fn stop(running: &Running, grace: Duration) {
    terminate_children(&[&running.session.child], grace);
}

#[test]
fn a_shell_that_honours_the_hangup_exits_on_its_own_terms() {
    // The handler runs and picks the exit code; a kill would report 1.
    let running = start_sh("trap 'exit 42' HUP; echo ready; while :; do sleep 1; done");

    stop(&running, LONG_GRACE);

    assert_eq!(running.session.child.try_reap(), Some(42));
    assert!(pid_gone(running.pid), "the shell must be reaped");
}

#[test]
fn a_shell_that_ignores_the_hangup_is_killed_after_the_grace() {
    let running = start_sh("trap '' HUP; echo ready; sleep 600");

    stop(&running, SHORT_GRACE);

    assert!(
        pid_gone(running.pid),
        "the shell must be killed AND reaped (a zombie still has a pid entry)"
    );
    // `sleep` inherited the ignored hangup and shares the shell's group.
    wait_until("the shell's process group to be empty", || {
        group_gone(running.pid)
    });
}

#[test]
fn a_background_job_in_its_own_group_survives_like_in_any_terminal() {
    // Monitor mode gives the background job a process group of its own, as an
    // interactive shell does.
    let running = start_sh(
        "set -m; nohup sleep 600 >/dev/null 2>&1 & echo \"job:$!:\"; echo ready; sleep 600",
    );
    let text = running.output_text();
    let job: u32 = text
        .split("job:")
        .nth(1)
        .and_then(|rest| rest.split(':').next())
        .and_then(|pid| pid.trim().parse().ok())
        .unwrap_or_else(|| panic!("no job pid in {text:?}"));

    stop(&running, SHORT_GRACE);

    assert!(pid_gone(running.pid), "the shell itself is gone");
    let survived = !pid_gone(job);
    // SAFETY: `job` is the `sleep` this test started; it is ours to end.
    unsafe { libc::kill(job as libc::pid_t, libc::SIGKILL) };
    assert!(
        survived,
        "a job outside the shell's group must not be signalled"
    );
}

#[test]
fn try_reap_is_none_while_running_and_the_exit_code_afterwards() {
    let running = start_sh("echo ready; read line; exit 3");
    assert_eq!(running.session.child.try_reap(), None);

    {
        use std::io::Write;
        let mut writer = running.session.writer.lock().unwrap();
        writer.write_all(b"go\n").unwrap();
    }

    wait_until("the shell to exit", || {
        running.session.child.try_reap() == Some(3)
    });
    assert!(pid_gone(running.pid));
    assert_eq!(
        running.session.child.try_reap(),
        Some(3),
        "the code is kept"
    );
}

#[test]
fn a_reaped_child_is_never_signalled_again() {
    let running = start_sh("echo ready; sleep 600");
    stop(&running, SHORT_GRACE);
    assert!(pid_gone(running.pid));

    // The pid may belong to anyone by now: both requests must be refused.
    assert!(!running.session.child.hang_up());
    assert!(!running.session.child.kill());
    stop(&running, SHORT_GRACE);
}

#[test]
fn several_shells_share_one_grace_period() {
    const GRACE: Duration = Duration::from_millis(500);
    let running: Vec<Running> = (0..4)
        .map(|_| start_sh("trap '' HUP; echo ready; sleep 600"))
        .collect();
    let slots: Vec<&ChildSlot> = running.iter().map(|r| &r.session.child).collect();

    let started = Instant::now();
    terminate_children(&slots, GRACE);
    let elapsed = started.elapsed();

    for shell in &running {
        assert!(pid_gone(shell.pid));
    }
    // One grace each would take four times `GRACE`.
    assert!(
        elapsed < GRACE * 3,
        "four shells took {elapsed:?}; the grace must not be paid per shell"
    );
}

#[test]
fn terminating_from_two_threads_at_once_is_safe() {
    let running = start_sh("trap '' HUP; echo ready; sleep 600");
    let session = running.session.clone();

    std::thread::scope(|scope| {
        for _ in 0..2 {
            scope.spawn(|| terminate_children(&[&session.child], SHORT_GRACE));
        }
    });

    assert!(pid_gone(running.pid));
    assert!(session.child.try_reap().is_some());
}

#[test]
fn the_reader_reports_the_code_of_a_shell_it_had_to_stop() {
    let running = start_sh("trap '' HUP; echo ready; sleep 600");

    stop(&running, SHORT_GRACE);

    // The slave side closes with the killed group, so the reader ends by
    // itself and records the code the slot reaped.
    wait_until("the reader to record an exit code", || {
        running.exit_code.lock().unwrap().is_some()
    });
    assert_eq!(
        *running.exit_code.lock().unwrap(),
        running.session.child.try_reap()
    );
}
