//! Writing to the shell's input, with a bound and a way out.
//!
//! Purpose: `pty_write` hands keystrokes and pastes to the shell. A terminal
//! queues only about a kilobyte of input, and a program that is not reading it
//! — a paste into one that ignores stdin — leaves it full. A plain `write_all`
//! then blocked for as long as that program chose, holding a blocking-pool
//! thread and the writer lock (every later keystroke queued behind it), and
//! nothing could reach it: not a session stop, and on Linux not even the
//! shell's death while something else kept the terminal open.
//!
//! Key decisions:
//!   - Unix: the master is non-blocking (`make_nonblocking`, at session
//!     creation). A full queue answers `WouldBlock`, and the write then waits
//!     for room in short `select` slices, checking the session's stop flag
//!     between them: a stop ends it within a slice, with `Interrupted`.
//!   - A write that makes no progress for `stall_limit` gives up with
//!     `TimedOut`, saying how much of the input went through. Progress resets
//!     the clock, so a slow reader is waited for; only a stalled one is not.
//!   - Non-blocking is a property of the master's open file description, which
//!     the reader's descriptor shares. That costs nothing there: the reader
//!     reads only after `select` says the master is readable, and treats a
//!     spurious `WouldBlock` as "not yet" (`output.rs`).
//!   - Windows (ConPTY): the input pipe cannot be waited on, so the write is
//!     the plain blocking one, as before.
//!
//! @coordinates-with pty.rs — `pty_write` calls `write_input` on the blocking pool
//! @coordinates-with pty/session.rs — makes the master non-blocking at creation; owns `shutdown`
//! @coordinates-with pty/output.rs — the reader side of the same descriptor
//! @module pty/input

use super::session::Session;
use std::io;
use std::time::Duration;

/// How long a write may make no progress before it gives up.
pub(super) const STALL_LIMIT: Duration = Duration::from_secs(10);

/// Write all of `data` to the shell's input. Fails with `Interrupted` when the
/// session is stopped, and `TimedOut` when the shell takes nothing for
/// `stall_limit`; both name how many bytes were written first.
pub(super) fn write_input(session: &Session, data: &[u8], stall_limit: Duration) -> io::Result<()> {
    platform::write_input(session, data, stall_limit)
}

#[cfg(unix)]
pub(super) use platform::make_nonblocking;

#[cfg(unix)]
mod platform {
    use super::Session;
    use portable_pty::MasterPty;
    use std::io::{self, Write};
    use std::os::fd::RawFd;
    use std::sync::atomic::Ordering;
    use std::sync::PoisonError;
    use std::time::{Duration, Instant};

    /// The longest a write waits for room before it looks at the stop flag.
    const SLICE: Duration = Duration::from_millis(50);

    /// Why a write ended early, with how far it got.
    fn cut_short(kind: io::ErrorKind, why: &str, written: usize, total: usize) -> io::Error {
        io::Error::new(kind, format!("{why} after {written} of {total} bytes"))
    }

    /// Put the master's open file description in non-blocking mode.
    pub(in crate::pty) fn make_nonblocking(master: &dyn MasterPty) -> io::Result<()> {
        let fd = master
            .as_raw_fd()
            .ok_or_else(|| io::Error::other("PTY master exposes no descriptor"))?;
        // SAFETY: `fcntl` with F_GETFL/F_SETFL only reads and sets the flags of
        // an open descriptor, which `master` keeps open for this call.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    pub(super) fn write_input(
        session: &Session,
        data: &[u8],
        stall_limit: Duration,
    ) -> io::Result<()> {
        let fd = session
            .master
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_raw_fd();
        let mut writer = session
            .writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut written = 0;
        let mut progressed = Instant::now();
        while written < data.len() {
            if session.shutdown.load(Ordering::Acquire) {
                let kind = io::ErrorKind::Interrupted;
                return Err(cut_short(kind, "the session ended", written, data.len()));
            }
            match writer.write(&data[written..]) {
                Ok(n) if n > 0 => {
                    written += n;
                    progressed = Instant::now();
                    continue;
                }
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
            if progressed.elapsed() >= stall_limit {
                let why = "the terminal took no input for too long";
                return Err(cut_short(io::ErrorKind::TimedOut, why, written, data.len()));
            }
            wait_for_room(fd, SLICE)?;
        }
        writer.flush()
    }

    /// Wait up to `slice` for the master to accept input. A descriptor
    /// `select` cannot watch is simply waited on for the slice.
    fn wait_for_room(fd: Option<RawFd>, slice: Duration) -> io::Result<()> {
        let Some(fd) = fd.filter(|fd| usize::try_from(*fd).is_ok_and(|fd| fd < libc::FD_SETSIZE))
        else {
            std::thread::sleep(slice);
            return Ok(());
        };
        let mut interval = libc::timeval {
            tv_sec: slice.as_secs() as libc::time_t,
            tv_usec: slice.subsec_micros() as libc::suseconds_t,
        };
        // SAFETY: an all-zero `fd_set` is a valid empty set; `FD_ZERO` then
        // initializes it the way the platform expects, and `fd` is open (the
        // session owns the master) and below `FD_SETSIZE` (checked above).
        let ready = unsafe {
            let mut set: libc::fd_set = std::mem::zeroed();
            libc::FD_ZERO(&mut set);
            libc::FD_SET(fd, &mut set);
            libc::select(
                fd + 1,
                std::ptr::null_mut(),
                &mut set,
                std::ptr::null_mut(),
                &mut interval,
            )
        };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(not(unix))]
mod platform {
    use super::Session;
    use std::io::{self, Write};
    use std::sync::PoisonError;
    use std::time::Duration;

    /// ConPTY's input pipe cannot be waited on: the plain blocking write.
    pub(super) fn write_input(
        session: &Session,
        data: &[u8],
        _stall_limit: Duration,
    ) -> io::Result<()> {
        let mut writer = session
            .writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        writer.write_all(data)?;
        writer.flush()
    }
}

#[cfg(all(test, unix))]
#[path = "input.test.rs"]
mod tests;
