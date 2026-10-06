// WI-RA6.1 — shared fixtures for the PTY tests: a real shell on a real pty,
//   pumped by the production reader loop, plus the pid probes the assertions
//   use. Every wait polls a condition against a deadline.

use super::reader::run_reader;
use super::session::{create_session, Session};
use super::spawn_policy::VettedCommand;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) const DEADLINE: Duration = Duration::from_secs(10);

/// Poll `holds` until it is true; fail the test when the deadline passes.
pub(super) fn wait_until(what: &str, mut holds: impl FnMut() -> bool) {
    let deadline = Instant::now() + DEADLINE;
    while !holds() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn probe(target: libc::pid_t) -> bool {
    // SAFETY: signal 0 delivers nothing; it only probes the target.
    let rc = unsafe { libc::kill(target, 0) };
    rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// `kill(pid, 0)` reports ESRCH only once the pid is neither running nor a
/// zombie — an unreaped child still answers.
pub(super) fn pid_gone(pid: u32) -> bool {
    probe(pid as libc::pid_t)
}

/// True once no process is left in the process group `pgid`.
pub(super) fn group_gone(pgid: u32) -> bool {
    probe(-(pgid as libc::pid_t))
}

/// Spawn `/bin/sh -c <script>` on a fresh pty, owned by window `owner`. A
/// script is something the spawn policy refuses, so the fixtures bypass it.
pub(super) fn spawn_sh(owner: &str, script: &str) -> Session {
    let command = VettedCommand::unvetted("/bin/sh", &["-c", script]);
    create_session(owner.into(), command, 80, 24, None).expect("spawn shell")
}

pub(super) fn shell_pid(session: &Session) -> u32 {
    session.child.pid().expect("shell pid")
}

/// A started session: its output is collected and its exit code recorded by
/// the production reader loop.
pub(super) struct Running {
    pub(super) session: Arc<Session>,
    pub(super) pid: u32,
    pub(super) output: Arc<Mutex<Vec<u8>>>,
    pub(super) exit_code: Arc<Mutex<Option<u32>>>,
}

impl Running {
    pub(super) fn output_text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
    }
}

/// Start a reader on `session` and return once the script printed `ready`, so
/// whatever it set up first (a trap, a background job) is in place.
pub(super) fn start(session: Session) -> Running {
    let session = Arc::new(session);
    let pid = shell_pid(&session);
    let output = Arc::new(Mutex::new(Vec::new()));
    let exit_code = Arc::new(Mutex::new(None));
    let (sink, code) = (output.clone(), exit_code.clone());
    session
        .start_reader(format!("pty-test-reader-{pid}"), move |session, source| {
            let exit = run_reader(pid, &session, source, |bytes| {
                sink.lock().unwrap().extend(bytes);
                true
            });
            *code.lock().unwrap() = Some(exit);
        })
        .unwrap_or_else(|_| panic!("start reader"));
    let running = Running {
        session,
        pid,
        output,
        exit_code,
    };
    wait_until("the shell to print ready", || {
        running.output_text().contains("ready")
    });
    running
}

/// `start(spawn_sh("main", script))`.
pub(super) fn start_sh(script: &str) -> Running {
    start(spawn_sh("main", script))
}
