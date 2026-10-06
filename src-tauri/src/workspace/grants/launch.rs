//! Re-granting the recorded roots at launch (WI-LX1.1).
//!
//! Purpose: runtime grants live in memory, so every launch re-issues the roots
//! the user chose before. Runs inside `setup_app`, on the main thread. Tauri
//! builds the configured `main` window BEFORE the setup hook, but a webview's
//! page load and every IPC request it makes are served on the main thread, so
//! no window can load or read anything until setup returns.
//!
//! Key decisions:
//!   - The wait is bounded ([`LAUNCH_REGRANT_WAIT`]): a recorded root on a
//!     stale network mount can block `canonicalize` for the mount's own
//!     timeout, and launch must not wait that long.
//!   - Roots resolve CONCURRENTLY, up to [`REGRANT_WORKERS`] at once, so a hung
//!     root holds one worker and delays no other root. A serial walk let a
//!     stale mount early in the list hold back every valid root behind it
//!     until after launch had stopped waiting.
//!   - What happened to each root is REPORTED ([`Regrant`]): a root still
//!     resolving at the deadline is granted whenever it resolves, and until
//!     then a window cannot read it; a worker that panicked is a failure, not
//!     "still running".
//!   - A recorded root is re-granted only if it still resolves to ITSELF:
//!     Tauri also inserts the canonical form of a granted path, so
//!     re-granting a name that has since become a link would grant its target.
//!
//! @coordinates-with workspace/grants/mod.rs — the state, the list file
//! @coordinates-with workspace/grants/scope.rs — the grant itself
//! @coordinates-with app_setup.rs — calls restore_at_launch
//! @module workspace/grants/launch

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use super::{canonical_dir, scope, WorkspaceGrants, GRANTS_FILE};
use crate::command_error::CommandError;

/// How long launch waits for recorded roots to be re-granted before it carries
/// on. Local disks finish in microseconds; only an unreachable mount is slower.
const LAUNCH_REGRANT_WAIT: Duration = Duration::from_millis(500);

/// Most roots resolved at once. A hung root costs one worker.
const REGRANT_WORKERS: usize = 8;

/// What became of one recorded root by the time launch stopped waiting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Regrant {
    /// Still resolving (or never reached): granted if and when it resolves.
    Pending,
    Granted,
    /// Now resolves somewhere else, so it was not granted.
    Moved(String),
    /// Gone, or unreachable right now.
    Unavailable(String),
    /// The grant was refused, or the worker panicked.
    Failed(String),
}

/// How a root is resolved. Injected so a test can make one hang or panic.
type Resolve = dyn Fn(&Path) -> Result<String, CommandError> + Send + Sync;

/// At launch: load the recorded roots and re-grant them (see module docs).
pub(crate) fn restore_at_launch<R: Runtime>(app: &AppHandle<R>) {
    match crate::app_paths::app_data_dir(app) {
        Ok(dir) => {
            restore_from(app, dir.join(GRANTS_FILE), LAUNCH_REGRANT_WAIT);
        }
        // Nothing can be re-granted, and choices this session stay in memory.
        Err(e) => log::warn!("[workspace-grants] No app data directory: {e}"),
    }
}

/// [`restore_at_launch`] against an explicit file and wait. Returns what
/// became of each recorded root.
pub(crate) fn restore_from<R: Runtime>(
    app: &AppHandle<R>,
    file: PathBuf,
    wait: Duration,
) -> Vec<(String, Regrant)> {
    use tauri_plugin_fs::FsExt;
    if let Some(scope) = app.try_fs_scope() {
        if let Err(e) = scope.forbid_file(&file) {
            log::warn!("[workspace-grants] Could not fence {:?}: {e}", file);
        }
    }
    let grants = app.state::<WorkspaceGrants>();
    grants.load(file);
    grants.persist_if_missing();
    let outcomes = regrant_all(app, grants.roots(), wait, Arc::new(canonical_dir));
    for (root, outcome) in &outcomes {
        match outcome {
            Regrant::Granted => {}
            Regrant::Pending => log::warn!(
                "[workspace-grants] {root:?} is still resolving; launch continues without it"
            ),
            Regrant::Moved(now) => {
                log::warn!("[workspace-grants] {root:?} now resolves to {now:?}; not granted")
            }
            Regrant::Unavailable(why) => {
                log::info!("[workspace-grants] {root:?} unavailable: {why}")
            }
            Regrant::Failed(why) => log::error!("[workspace-grants] {root:?} not granted: {why}"),
        }
    }
    outcomes
}

/// Resolve and grant one recorded root.
fn regrant_one<R: Runtime>(app: &AppHandle<R>, root: &str, resolve: &Resolve) -> Regrant {
    match resolve(Path::new(root)) {
        Ok(now) if now == root => match scope::grant_workspace_scope(app, root) {
            Ok(()) => Regrant::Granted,
            Err(e) => Regrant::Failed(e.message().to_owned()),
        },
        Ok(now) => Regrant::Moved(now),
        Err(e) => Regrant::Unavailable(e.message().to_owned()),
    }
}

/// Re-grant `roots` on up to [`REGRANT_WORKERS`] threads, waiting at most
/// `wait` for all of them. A root not settled by then is reported
/// [`Regrant::Pending`]; its worker carries on and grants it if it resolves.
fn regrant_all<R: Runtime>(
    app: &AppHandle<R>,
    roots: Vec<String>,
    wait: Duration,
    resolve: Arc<Resolve>,
) -> Vec<(String, Regrant)> {
    let deadline = Instant::now() + wait;
    let roots = Arc::new(roots);
    let outcomes = Arc::new(Mutex::new(vec![Regrant::Pending; roots.len()]));
    let next = Arc::new(AtomicUsize::new(0));
    let (done, finished) = mpsc::channel::<()>();
    let mut started = 0;
    for _ in 0..roots.len().min(REGRANT_WORKERS) {
        let work = Worker {
            app: app.clone(),
            roots: Arc::clone(&roots),
            outcomes: Arc::clone(&outcomes),
            next: Arc::clone(&next),
            resolve: Arc::clone(&resolve),
            _done: Done(done.clone()),
        };
        match std::thread::Builder::new()
            .name("workspace-regrant".into())
            .spawn(move || work.run())
        {
            Ok(_) => started += 1,
            Err(e) => log::error!("[workspace-grants] Could not start a re-grant worker: {e}"),
        }
    }
    drop(done);
    for _ in 0..started {
        if finished
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            break;
        }
    }
    let settled = outcomes.lock().unwrap_or_else(|p| p.into_inner()).clone();
    roots.iter().cloned().zip(settled).collect()
}

/// One re-grant thread: takes the next unclaimed root until none are left.
struct Worker<R: Runtime> {
    app: AppHandle<R>,
    roots: Arc<Vec<String>>,
    outcomes: Arc<Mutex<Vec<Regrant>>>,
    next: Arc<AtomicUsize>,
    resolve: Arc<Resolve>,
    _done: Done,
}

impl<R: Runtime> Worker<R> {
    fn run(self) {
        loop {
            let i = self.next.fetch_add(1, Ordering::SeqCst);
            let Some(root) = self.roots.get(i) else {
                return;
            };
            // A panic is this root's failure, not the worker's end: the roots
            // after it still get their turn, and nothing reads it as a hang.
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                regrant_one(&self.app, root, self.resolve.as_ref())
            }))
            .unwrap_or_else(|_| Regrant::Failed("resolving it panicked".to_owned()));
            self.outcomes.lock().unwrap_or_else(|p| p.into_inner())[i] = outcome;
        }
    }
}

/// Tells the waiting launch that one worker is done — on drop, so a worker
/// that ends any way at all is counted.
struct Done(mpsc::Sender<()>);

impl Drop for Done {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[cfg(test)]
#[path = "launch.test.rs"]
mod tests;
