// WI-RA7C.6 — a write to a shell that does not read its input is bounded and
// can be cancelled. A full terminal input queue used to block `write_all` for
// as long as the foreground program chose not to read, holding a blocking-pool
// thread and the writer lock, and nothing — not even a session stop — could
// reach it.

use super::write_input;
use crate::pty::test_support::{start_sh, Running, DEADLINE};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

/// Far more input than a terminal queues (about a kilobyte), in whole lines,
/// so the terminal holds it rather than discarding an over-long line.
fn more_than_the_queue_holds() -> Vec<u8> {
    b"line\n".repeat(200_000)
}

/// Start the write on its own thread; the receiver yields its outcome.
fn write_in_background(
    running: &Running,
    stall_limit: Duration,
) -> mpsc::Receiver<std::io::Result<()>> {
    let (done, outcome) = mpsc::channel();
    let session = running.session.clone();
    std::thread::spawn(move || {
        let _ = done.send(write_input(
            &session,
            &more_than_the_queue_holds(),
            stall_limit,
        ));
    });
    outcome
}

#[test]
fn a_write_nobody_reads_gives_up_after_the_stall_limit() {
    // `sleep` holds the terminal and never reads it.
    let running = start_sh("echo ready; sleep 600");

    let outcome = write_in_background(&running, Duration::from_millis(300));

    let result = outcome
        .recv_timeout(DEADLINE)
        .expect("a write that makes no progress must end");
    let error = result.expect_err("the input was not all written");
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(error.to_string().contains("bytes"), "{error}");
    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}

#[test]
fn a_session_stop_ends_a_blocked_write() {
    let running = start_sh("echo ready; sleep 600");
    let outcome = write_in_background(&running, Duration::from_secs(600));
    assert!(
        outcome.recv_timeout(Duration::from_millis(100)).is_err(),
        "premise: the queue is full, so the write is waiting"
    );

    // The flag a stop raises — before any signal reaches the shell, which
    // stays alive and keeps not reading.
    running.session.shutdown.store(true, Ordering::Release);

    let result = outcome
        .recv_timeout(DEADLINE)
        .expect("a stop must end the write");
    assert_eq!(
        result.expect_err("the stop cut the write short").kind(),
        std::io::ErrorKind::Interrupted
    );
    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}

#[test]
fn a_shell_that_reads_gets_all_of_a_long_input() {
    // `wc -c` reads every byte and reports the count once input ends.
    // `ready` is printed only after `stty`: written while the terminal is
    // still canonical, a line longer than its input limit (MAX_CANON, about a
    // kilobyte) is cut short, so the count never reaches 300000.
    let running = start_sh("stty -icanon -echo; echo ready; head -c 300000 | wc -c");
    let data: Vec<u8> = b"0123456789abcdef"
        .iter()
        .copied()
        .cycle()
        .take(300_000)
        .collect();

    write_input(&running.session, &data, Duration::from_secs(5)).expect("written");

    crate::pty::test_support::wait_until("the count to be printed", || {
        running.output_text().contains("300000")
    });
    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}

#[test]
fn an_empty_write_is_a_no_op() {
    let running = start_sh("echo ready; sleep 600");
    write_input(&running.session, b"", Duration::from_millis(1)).expect("nothing to write");
    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}
