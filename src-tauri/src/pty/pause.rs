//! Flow control for the PTY reader: a pause the reader truly sleeps in.
//!
//! Purpose: `pty_pause` / `pty_resume` back the frontend's watermark flow
//! control. The reader blocks on a `Condvar` while paused (zero CPU, no
//! busy-wait), and anything that stops a session resumes it first so a paused
//! reader is never left asleep.
//!
//! @coordinates-with pty/session.rs — `Session::pause_ctl`
//! @coordinates-with pty/reader.rs — waits here between reads
//! @module pty/pause

use std::sync::{Condvar, Mutex};

pub(super) struct PauseControl {
    paused: Mutex<bool>,
    cond: Condvar,
}

impl PauseControl {
    pub(super) fn new() -> Self {
        Self {
            paused: Mutex::new(false),
            cond: Condvar::new(),
        }
    }

    pub(super) fn pause(&self) {
        *self.paused.lock().unwrap_or_else(|p| p.into_inner()) = true;
    }

    pub(super) fn resume(&self) {
        *self.paused.lock().unwrap_or_else(|p| p.into_inner()) = false;
        self.cond.notify_one();
    }

    /// Block the calling thread until unpaused. No-op when not paused.
    pub(super) fn wait_if_paused(&self) {
        let mut guard = self.paused.lock().unwrap_or_else(|p| p.into_inner());
        while *guard {
            guard = self.cond.wait(guard).unwrap_or_else(|p| p.into_inner());
        }
    }
}
