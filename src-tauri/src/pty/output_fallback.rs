//! The output source where the pty offers nothing to wait on (Windows,
//! ConPTY): a blocking read, and an interrupt that is a flag honoured
//! before and after it.
//!
//! Compiled into Unix test builds too (`output.rs`), so the logic Windows
//! runs is exercised on the platforms the tests run on.
//!
//! @coordinates-with pty/output.rs — the platform split, and the Unix source
//! @module pty/output_fallback

use super::Chunk;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How often a bounded wait looks at the interrupt flag.
const FLAG_POLL: Duration = Duration::from_millis(10);

pub(in crate::pty) struct OutputSource {
    reader: Box<dyn Read + Send>,
    interrupted: Arc<AtomicBool>,
}

pub(in crate::pty) struct Interrupter {
    interrupted: Arc<AtomicBool>,
}

#[cfg(not(unix))]
pub(super) fn channel(master: &dyn super::MasterPty) -> io::Result<(OutputSource, Interrupter)> {
    let reader = master.try_clone_reader().map_err(io::Error::other)?;
    Ok(from_reader(reader))
}

pub(super) fn from_reader(reader: Box<dyn Read + Send>) -> (OutputSource, Interrupter) {
    let interrupted = Arc::new(AtomicBool::new(false));
    (
        OutputSource {
            reader,
            interrupted: interrupted.clone(),
        },
        Interrupter { interrupted },
    )
}

impl OutputSource {
    /// `read`: the pipe cannot be waited on with a bound, so `idle` never
    /// expires here and `None` is never returned.
    pub(in crate::pty) fn read_within(
        &mut self,
        buf: &mut [u8],
        _idle: Duration,
    ) -> io::Result<Option<Chunk>> {
        self.read(buf).map(Some)
    }

    /// Read the next chunk of output. An interrupt wins over whatever a
    /// read that was blocked when it arrived goes on to return.
    pub(in crate::pty) fn read(&mut self, buf: &mut [u8]) -> io::Result<Chunk> {
        loop {
            if self.interrupted.load(Ordering::Acquire) {
                return Ok(Chunk::Interrupted);
            }
            let read = self.reader.read(buf);
            if self.interrupted.load(Ordering::Acquire) {
                return Ok(Chunk::Interrupted);
            }
            return match read {
                Ok(0) => Ok(Chunk::Eof),
                Ok(n) => Ok(Chunk::Data(n)),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => Err(e),
            };
        }
    }

    /// Wait for `timeout`; true when the session interrupted the wait.
    pub(in crate::pty) fn interrupted_within(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.interrupted.load(Ordering::Acquire) {
                return Ok(true);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(false);
            }
            std::thread::sleep(left.min(FLAG_POLL));
        }
    }
}

impl Interrupter {
    /// Make every later read and wait return `Interrupted`. Never blocks;
    /// safe to call more than once.
    pub(in crate::pty) fn interrupt(&self) {
        self.interrupted.store(true, Ordering::Release);
    }
}
