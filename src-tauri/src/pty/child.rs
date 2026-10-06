//! The shell a PTY session spawned — signalling, reaping, and the escalating
//! stop that ends it.
//!
//! Purpose: one owner for the child process for the session's whole life, and
//! one `terminate_children` used by every path that ends a session (close,
//! kill, window destroy, quit, a reader that lost its channel).
//!
//! Key decisions:
//!   - The child never leaves its slot. A reader thread that owned it could
//!     only be told to stop with a hangup, which a shell is free to ignore.
//!   - Signals are sent only under the slot lock while the child is still
//!     unreaped. An unreaped pid cannot be recycled, so a signal can never
//!     land on an unrelated process that inherited the number.
//!   - Hang up, wait a bounded grace, then kill. The hangup lets a shell save
//!     its history and forward the hangup to its jobs; the kill is what a
//!     shell that ignores hangups gets.
//!   - Both signals go to the shell's process GROUP (the shell is a session
//!     leader, so its pid is its group id). A job-control shell puts background
//!     jobs in groups of their own, so a `nohup`-ed job survives, as it does in
//!     any terminal; processes sharing the shell's own group do not.
//!   - Nothing here blocks without a bound. A child that cannot be signalled
//!     (it changed user) or does not die is handed to a detached thread that
//!     reaps it whenever it does exit, so quit is never held hostage.
//!
//! @coordinates-with pty/session.rs — `Session::child`, `terminate`, `kill_all`
//! @coordinates-with pty/reader.rs — reaps on natural exit, terminates otherwise
//! @module pty/child

use portable_pty::Child;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

type BoxedChild = Box<dyn Child + Send + Sync>;

/// How long a shell gets to act on the hangup before it is killed.
pub(super) const HANGUP_GRACE: Duration = Duration::from_millis(1000);
/// How long a killed child gets to disappear before it is handed to a
/// detached reaper. A kill normally lands within milliseconds.
const KILL_TIMEOUT: Duration = Duration::from_millis(2000);
/// Interval between exit checks while waiting on a signalled child.
const REAP_POLL: Duration = Duration::from_millis(10);
/// Exit code reported when the real one cannot be read.
const UNKNOWN_EXIT: u32 = 1;

enum State {
    /// Running, or exited but not yet reaped. The pid is still ours.
    Live(BoxedChild),
    /// Reaped, or handed to the detached reaper: the pid may be recycled, so
    /// nothing signals it again.
    Gone(u32),
}

pub(super) struct ChildSlot {
    pid: Option<u32>,
    state: Mutex<State>,
}

impl ChildSlot {
    pub(super) fn new(child: BoxedChild) -> Self {
        Self {
            pid: child.process_id(),
            state: Mutex::new(State::Live(child)),
        }
    }

    /// The pid the child was spawned with. Stays readable after the child is
    /// gone — never signal it directly.
    pub(super) fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Reap the child if it has exited. `None` while it is still running.
    pub(super) fn try_reap(&self) -> Option<u32> {
        let mut state = self.lock_state();
        let code = match &mut *state {
            State::Gone(code) => return Some(*code),
            State::Live(child) => match child.try_wait() {
                Ok(Some(status)) => status.exit_code(),
                Ok(None) => return None,
                Err(e) => {
                    log::warn!("[pty] cannot read exit status of {:?}: {e}", self.pid);
                    UNKNOWN_EXIT
                }
            },
        };
        *state = State::Gone(code);
        Some(code)
    }

    /// Ask the child to exit. Returns whether a request it can act on was
    /// delivered — there is nothing to wait for otherwise.
    fn hang_up(&self) -> bool {
        match &*self.lock_state() {
            State::Live(_) => self.pid.is_some_and(platform::hang_up),
            State::Gone(_) => false,
        }
    }

    /// Kill the child outright. Returns whether it is worth waiting for it to
    /// disappear.
    fn kill(&self) -> bool {
        match &mut *self.lock_state() {
            State::Live(child) => platform::kill(self.pid, child),
            State::Gone(_) => false,
        }
    }

    /// Give up waiting on a child that is still unreaped: a detached thread
    /// reaps it when it finally exits, and the slot stops signalling its pid.
    fn abandon(&self) {
        let mut state = self.lock_state();
        match std::mem::replace(&mut *state, State::Gone(UNKNOWN_EXIT)) {
            State::Gone(code) => *state = State::Gone(code),
            State::Live(mut child) => {
                log::error!(
                    "[pty] child {:?} outlived its kill; reaping it in the background",
                    self.pid
                );
                let spawned =
                    std::thread::Builder::new()
                        .name("pty-reaper".into())
                        .spawn(move || {
                            let _ = child.wait();
                        });
                if let Err(e) = spawned {
                    log::error!("[pty] cannot start a reaper for {:?}: {e}", self.pid);
                }
            }
        }
    }
}

/// True once every slot is reaped; false when `timeout` ran out first.
fn wait_until_reaped(slots: &[&ChildSlot], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if slots.iter().all(|slot| slot.try_reap().is_some()) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(REAP_POLL);
    }
}

/// End every child: hang up, wait up to `grace` for all of them together, kill
/// whatever is left, and reap. Idempotent, and safe to run from several
/// threads at once — a child is signalled only while it is still live.
///
/// Blocking, but bounded by `grace` plus the kill timeout however many
/// children there are.
pub(super) fn terminate_children(slots: &[&ChildSlot], grace: Duration) {
    // Not `any`: every child must be hung up, not just the first.
    let asked = slots.iter().filter(|slot| slot.hang_up()).count();
    if asked > 0 && wait_until_reaped(slots, grace) {
        return;
    }
    let killed: Vec<&ChildSlot> = slots.iter().copied().filter(|slot| slot.kill()).collect();
    wait_until_reaped(&killed, KILL_TIMEOUT);
    for slot in slots {
        slot.abandon();
    }
}

#[cfg(unix)]
mod platform {
    use super::BoxedChild;
    use std::io;

    /// Signal the process group led by `pid`. Refuses ids that address
    /// anything but one specific group: 0 is the caller's own group.
    fn signal_group(pid: u32, signal: libc::c_int) -> io::Result<()> {
        let group = libc::pid_t::try_from(pid).ok().filter(|group| *group > 1);
        let Some(group) = group else {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        };
        // SAFETY: `killpg` only reads its two integer arguments.
        if unsafe { libc::killpg(group, signal) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn signal_process(pid: u32, signal: libc::c_int) -> io::Result<()> {
        let target = libc::pid_t::try_from(pid).ok().filter(|target| *target > 1);
        let Some(target) = target else {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        };
        // SAFETY: `kill` only reads its two integer arguments.
        if unsafe { libc::kill(target, signal) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(super) fn hang_up(pid: u32) -> bool {
        signal_group(pid, libc::SIGHUP).is_ok()
    }

    /// The group gets the kill so nothing in it survives the shell; the answer
    /// comes from the child itself, because it is the one that gets reaped. A
    /// child that changed user cannot be signalled at all, and waiting for it
    /// would wait for as long as it likes.
    pub(super) fn kill(pid: Option<u32>, _child: &mut BoxedChild) -> bool {
        let Some(pid) = pid else {
            return false;
        };
        let _ = signal_group(pid, libc::SIGKILL);
        match signal_process(pid, libc::SIGKILL) {
            Ok(()) => true,
            // Already a corpse the kernel no longer signals: reap it.
            Err(e) if e.raw_os_error() == Some(libc::ESRCH) => true,
            Err(e) => {
                log::warn!("[pty] cannot kill child {pid}: {e}");
                false
            }
        }
    }
}

#[cfg(not(unix))]
mod platform {
    use super::BoxedChild;

    /// No graceful request exists for a console process; go straight to kill.
    pub(super) fn hang_up(_pid: u32) -> bool {
        false
    }

    pub(super) fn kill(pid: Option<u32>, child: &mut BoxedChild) -> bool {
        match child.kill() {
            Ok(()) => true,
            Err(e) => {
                log::warn!("[pty] cannot kill child {pid:?}: {e}");
                false
            }
        }
    }
}

// Unix-only: the tests spawn `/bin/sh` and probe pids with `kill(pid, 0)`.
#[cfg(all(test, unix))]
#[path = "child.test.rs"]
mod tests;
