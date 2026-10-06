//! # Watcher event batching
//!
//! Purpose: Turns the per-change stream a `notify` watcher produces into a few
//! bounded `fs:changed` batches, so a burst (a branch switch, a formatter run)
//! crosses the IPC boundary as a handful of payloads instead of one event per
//! file.
//!
//! Pipeline: notify callback → bounded queue (`signal_queue`) →
//! `run_batch_loop` on the watcher's own thread → `PendingBatch`
//! (order-preserving, repeat-free) → one `FsChangeBatch` per window of time.
//!
//! Key decisions:
//!   - Deferred, never suppressed. Every distinct change that arrives is in
//!     some batch; a repeat is dropped only when nothing else touched its
//!     paths since the identical change, so `create → remove → create` keeps
//!     all three and the last word on a path is always the true one.
//!   - Bounded both ways. A batch carries at most `MAX_BATCH_CHANGES` changes
//!     (a larger burst cuts the window short and flushes early) and the queue
//!     holds at most `QUEUE_CAPACITY` signals. A full queue blocks the notify
//!     thread instead of dropping: a dropped change is an open document that
//!     never reloads, and back-pressure lets the OS report its own overflow,
//!     which arrives here as `Signal::Rescan`.
//!   - The window is counted from the FIRST change of a batch, so delivery
//!     latency is bounded however long a burst lasts.
//!   - Nothing is emitted for a watcher that is gone: when the queue
//!     disconnects, what it saw last is dropped rather than delivered late.
//!
//! @coordinates-with watcher.rs — classifies notify results into `Signal`s and emits the batches
//! @coordinates-with src/services/workspaceEvents/types.ts — the frontend twin of `FsChangeBatch`
//! @module watcher/batch

use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::time::{Duration, Instant};

/// How long changes are collected before a batch is emitted.
pub(crate) const BATCH_WINDOW: Duration = Duration::from_millis(75);

/// Most changes one batch may carry.
pub(crate) const MAX_BATCH_CHANGES: usize = 512;

/// Capacity of the queue between the notify thread and the batch thread.
pub(crate) const QUEUE_CAPACITY: usize = 1024;

/// What happened to the paths of one change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FsChangeKind {
    Create,
    Modify,
    Remove,
    Rename,
}

/// One filesystem change. `paths` are spelled under the watched root; a
/// rename the OS reported as a pair carries `[old, new]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct FsChange {
    pub kind: FsChangeKind,
    pub paths: Vec<String>,
}

/// The `fs:changed` payload: every change one watcher saw in one window of
/// time, in the order the OS reported them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsChangeBatch {
    /// The watcher's id — the owning window's label.
    pub watch_id: String,
    /// The root the watcher was started on, as the caller spelled it.
    pub root_path: String,
    pub changes: Vec<FsChange>,
    /// True when the watcher lost track of the tree (the OS dropped events,
    /// or the watcher reported an error): `changes` may be incomplete and the
    /// frontend must re-list rather than trust them alone.
    pub rescan: bool,
}

/// One notify callback result, reduced to what the owning window needs.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Signal {
    Change(FsChange),
    Rescan,
}

/// The bounded queue a watcher's notify callback feeds and its batch thread
/// drains.
pub(crate) fn signal_queue() -> (SyncSender<Signal>, Receiver<Signal>) {
    sync_channel(QUEUE_CAPACITY)
}

/// The changes collected for the batch being built.
#[derive(Default)]
pub(crate) struct PendingBatch {
    changes: Vec<FsChange>,
    /// Index into `changes` of the last change that touched each path.
    last_touch: HashMap<String, usize>,
    rescan: bool,
}

impl PendingBatch {
    pub(crate) fn push(&mut self, signal: Signal) {
        match signal {
            Signal::Rescan => self.rescan = true,
            Signal::Change(change) => {
                if self.repeats_last_touch(&change) {
                    return;
                }
                let index = self.changes.len();
                for path in &change.paths {
                    self.last_touch.insert(path.clone(), index);
                }
                self.changes.push(change);
            }
        }
    }

    /// True when `change` is identical to the change that last touched every
    /// one of its paths — the duplicate FSEvents fires for a single write.
    /// Any other change to one of those paths in between makes it news again.
    fn repeats_last_touch(&self, change: &FsChange) -> bool {
        let mut touched = change.paths.iter().map(|path| self.last_touch.get(path));
        let Some(Some(&first)) = touched.next() else {
            return false;
        };
        touched.all(|index| index == Some(&first)) && self.changes[first] == *change
    }

    pub(crate) fn len(&self) -> usize {
        self.changes.len()
    }

    /// Hand over what was collected and start afresh; `None` when nothing was.
    pub(crate) fn take(&mut self, watch_id: &str, root_path: &str) -> Option<FsChangeBatch> {
        let collected = std::mem::take(self);
        if collected.changes.is_empty() && !collected.rescan {
            return None;
        }
        Some(FsChangeBatch {
            watch_id: watch_id.to_string(),
            root_path: root_path.to_string(),
            changes: collected.changes,
            rescan: collected.rescan,
        })
    }
}

/// How one watcher's batches are cut.
pub(crate) struct BatchConfig {
    pub watch_id: String,
    pub root_path: String,
    pub window: Duration,
    pub max_changes: usize,
}

/// Drain `signals` into batches until the watcher that feeds them is dropped.
///
/// Blocks for the first signal of a batch, collects until `window` has
/// elapsed or the batch is full, then calls `emit` once.
pub(crate) fn run_batch_loop(
    signals: &Receiver<Signal>,
    config: &BatchConfig,
    mut emit: impl FnMut(FsChangeBatch),
) {
    let mut pending = PendingBatch::default();
    while let Ok(first) = signals.recv() {
        pending.push(first);
        let deadline = Instant::now() + config.window;
        while pending.len() < config.max_changes {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match signals.recv_timeout(remaining) {
                Ok(signal) => pending.push(signal),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if let Some(batch) = pending.take(&config.watch_id, &config.root_path) {
            emit(batch);
        }
    }
}

#[cfg(test)]
#[path = "batch.test.rs"]
mod tests;
