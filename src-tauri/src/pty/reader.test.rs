// WI-RA7C.6 — a shell that exits while something else still holds its terminal
// open is reported as exited. The output never ends in that case (the holder
// keeps the slave side open), and the reader used to learn of the exit only
// from the end of output — so a `nohup`-ed job, or a shell that left a
// background job behind, kept the terminal looking alive for as long as the
// job ran.

use crate::pty::test_support::{start_sh, wait_until, Running};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

/// Hold the slave side open from outside the shell, the way a background job
/// that survives the shell does.
fn hold_slave(running: &Running) -> std::fs::File {
    let name = running
        .session
        .master
        .lock()
        .unwrap()
        .tty_name()
        .expect("slave tty name");
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
        .open(name)
        .expect("open slave")
}

fn type_line(running: &Running) {
    let mut writer = running.session.writer.lock().unwrap();
    writer.write_all(b"\n").expect("type a line");
    writer.flush().expect("flush");
}

fn exit_code(running: &Running) -> Option<u32> {
    *running.exit_code.lock().unwrap()
}

#[test]
fn a_shell_that_exits_while_its_terminal_is_held_open_is_reported_with_its_code() {
    let running = start_sh("echo ready; read _; exit 3");
    let holder = hold_slave(&running);

    type_line(&running);

    wait_until("the shell's exit to be reported", || {
        exit_code(&running).is_some()
    });
    assert_eq!(exit_code(&running), Some(3));
    drop(holder);
    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}

#[test]
fn a_shell_that_is_idle_but_alive_keeps_its_terminal() {
    // Idle for longer than the exit check's interval, then talks again: a
    // check that misread "no output" as "exited" would have ended the reader,
    // and the second line would never arrive.
    let running = start_sh("echo ready; sleep 1; echo still-here; read _");

    wait_until("the shell to speak after being idle", || {
        running.output_text().contains("still-here")
    });
    assert_eq!(exit_code(&running), None);

    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}

#[test]
fn output_written_just_before_the_exit_is_still_delivered() {
    let running = start_sh("echo ready; read _; echo last-words; exit 0");
    let holder = hold_slave(&running);

    type_line(&running);

    wait_until("the shell's exit to be reported", || {
        exit_code(&running).is_some()
    });
    assert!(
        running.output_text().contains("last-words"),
        "{:?}",
        running.output_text()
    );
    drop(holder);
    crate::pty::session::terminate(std::slice::from_ref(&running.session));
}

// -- the pump against output that never ends ----------------------------------

use super::{run_reader, PumpSource, IDLE_EXIT_CHECK};
use crate::pty::output::Chunk;
use crate::pty::test_support::{spawn_sh, DEADLINE};
use std::time::Duration;

/// A terminal nothing is written to and nothing closes: the reader's view of a
/// shell whose background job holds the terminal after the shell is gone (on
/// Linux; macOS revokes the terminal when the shell exits, so a real pty there
/// cannot show it). Each read reports the idle interval as passed at once, so
/// the test spends no time waiting it out.
struct NeverEnds;

impl PumpSource for NeverEnds {
    fn read_within(&mut self, _buf: &mut [u8], idle: Duration) -> std::io::Result<Option<Chunk>> {
        assert_eq!(idle, IDLE_EXIT_CHECK);
        Ok(None)
    }

    fn interrupted_within(&self, _timeout: Duration) -> std::io::Result<bool> {
        Ok(false)
    }
}

/// Run the production reader loop on its own thread; `None` if it is still
/// running at the deadline.
fn reader_result(script: &str) -> Option<u32> {
    let session = std::sync::Arc::new(spawn_sh("main", script));
    let pid = session.child.pid().expect("shell pid");
    let (done, result) = std::sync::mpsc::channel();
    let reading = session.clone();
    std::thread::spawn(move || {
        let code = run_reader(pid, &reading, NeverEnds, |_| true);
        let _ = done.send(code);
    });
    let code = result.recv_timeout(DEADLINE).ok();
    crate::pty::session::terminate(std::slice::from_ref(&session));
    code
}

#[test]
fn the_reader_ends_with_the_shells_code_though_its_output_never_does() {
    assert_eq!(
        reader_result("exit 7"),
        Some(7),
        "the reader must end once the shell has exited"
    );
}
