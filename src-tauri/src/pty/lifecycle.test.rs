// WI-RA6.1 — closing a session ends its shell, its reader thread and its
//   master descriptors even when the shell ignores SIGHUP or an orphan keeps
//   the slave side open.
// WI-RA6.2 — `pty_close` on a started session terminates the shell.
//
// Driven through the real commands on a mock runtime, so the assertions hold
// for what the frontend actually calls. Every wait is a condition polled
// against a deadline; nothing here sleeps for a fixed time and then asserts.

use super::session::Session;
use super::test_support::{group_gone, pid_gone, spawn_sh, DEADLINE};
use super::*;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::{Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::test::MockRuntime;
use tauri::Listener;

fn mock_app() -> tauri::App<MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(PtyState::default());
    app
}

async fn eventually(what: &str, mut holds: impl FnMut() -> bool) {
    let deadline = Instant::now() + DEADLINE;
    while !holds() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

struct Started {
    id: u32,
    shell_pid: u32,
    session: Weak<Session>,
    output: Arc<StdMutex<Vec<u8>>>,
}

impl Started {
    /// The reader thread holds a strong reference for as long as it runs, and
    /// the session owns the master and writer descriptors: zero strong
    /// references means the thread ended and those descriptors were dropped.
    fn released(&self) -> bool {
        self.session.strong_count() == 0
    }
}

/// Spawn `/bin/sh -c <script>`, register it and start its reader, returning
/// once the script has printed `ready` (so a trap it installs is in force).
async fn start(app: &tauri::App<MockRuntime>, script: &str) -> Started {
    let session = Arc::new(spawn_sh("main", script));
    let shell_pid = session.child.pid().expect("shell pid");
    let state = app.state::<PtyState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().await.insert(id, session.clone());

    let output = Arc::new(StdMutex::new(Vec::new()));
    let sink = output.clone();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Raw(bytes) = body {
            sink.lock().unwrap().extend(bytes);
        }
        Ok(())
    });
    reader::pty_start(id, channel, app.state::<PtyState>(), app.handle().clone())
        .await
        .expect("start reader");

    let seen = output.clone();
    eventually("the shell to print ready", move || {
        seen.lock().unwrap().windows(5).any(|w| w == b"ready")
    })
    .await;
    Started {
        id,
        shell_pid,
        session: Arc::downgrade(&session),
        output,
    }
}

/// Keep the slave side open from outside the shell's process group, the way a
/// `nohup`-ed grandchild does after its shell is gone.
async fn hold_slave_open(app: &tauri::App<MockRuntime>, id: u32) -> std::fs::File {
    let state = app.state::<PtyState>();
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .expect("session");
    let name = session
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

/// The kernel hangs the slave up only when EVERY master descriptor is closed
/// (the session's, the writer's and the reader's): a read then reports EOF
/// (macOS) or EIO (Linux) instead of "no data yet".
///
/// Bytes are "not yet": dropping portable-pty's master writer writes `\n`
/// and VEOF into the master (`UnixMasterWriter::drop`), so a read that lands
/// between the writer's drop and the last master close returns that newline.
/// Linux CI saw exactly that (`Ok(1)`); the next poll drains it and then sees
/// the hangup.
fn master_fully_closed(mut slave: &std::fs::File) -> bool {
    let mut byte = [0u8; 1];
    match slave.read(&mut byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) if e.raw_os_error() == Some(libc::EIO) => true,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => false,
        other => panic!("unexpected slave read result: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pty_close_terminates_a_started_shell() {
    let app = mock_app();
    let started = start(&app, "echo ready; sleep 600").await;

    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");

    eventually("the shell to be killed and reaped", || {
        pid_gone(started.shell_pid)
    })
    .await;
    eventually("the reader thread to end", || started.released()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_kills_a_shell_that_ignores_sighup() {
    let app = mock_app();
    let started = start(&app, "trap '' HUP; echo ready; sleep 600").await;

    // The order the frontend uses: kill, then close.
    pty_kill(started.id, app.state::<PtyState>())
        .await
        .expect("kill");
    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");

    eventually("the HUP-ignoring shell to be killed and reaped", || {
        pid_gone(started.shell_pid)
    })
    .await;
    eventually("the shell's process group to be empty", || {
        group_gone(started.shell_pid)
    })
    .await;
    eventually("the reader thread to end", || started.released()).await;
}

/// The race the probe must survive, made deterministic: the writer is gone
/// (its drop wrote `\n` + VEOF) but the master is still open, so the slave
/// has a byte to read. That is "not closed yet", not a malformed result.
#[test]
fn the_writers_parting_newline_reads_as_not_yet_closed() {
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let name = pair.master.tty_name().expect("slave tty name");
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
        .open(name)
        .expect("open slave");
    drop(pair.master.take_writer().expect("writer"));

    assert!(!master_fully_closed(&slave), "the master is still open");
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_frees_the_reader_and_master_while_an_orphan_holds_the_slave() {
    let app = mock_app();
    let started = start(&app, "echo ready; sleep 600").await;
    let slave = hold_slave_open(&app, started.id).await;
    assert!(
        !master_fully_closed(&slave),
        "the master is open while the session lives"
    );

    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");

    eventually("the shell to be killed and reaped", || {
        pid_gone(started.shell_pid)
    })
    .await;
    eventually("the reader thread to end", || started.released()).await;
    eventually("every master descriptor to be closed", || {
        master_fully_closed(&slave)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_paused_session_still_ends_its_reader() {
    let app = mock_app();
    let started = start(&app, "echo ready; sleep 600").await;
    pty_pause(started.id, app.state::<PtyState>())
        .await
        .expect("pause");

    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");

    eventually("the shell to be killed and reaped", || {
        pid_gone(started.shell_pid)
    })
    .await;
    eventually("the reader thread to end", || started.released()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_destroyed_window_kills_its_sighup_ignoring_shell() {
    let app = mock_app();
    let started = start(&app, "trap '' HUP; echo ready; sleep 600").await;

    let handle = app.handle().clone();
    tokio::task::spawn_blocking(move || close_window_sessions(&handle, "main"))
        .await
        .expect("window cleanup");

    eventually("the HUP-ignoring shell to be killed and reaped", || {
        pid_gone(started.shell_pid)
    })
    .await;
    eventually("the reader thread to end", || started.released()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn quit_kills_a_sighup_ignoring_shell() {
    let app = mock_app();
    let started = start(&app, "trap '' HUP; echo ready; sleep 600").await;

    let handle = app.handle().clone();
    tokio::task::spawn_blocking(move || kill_all(&handle))
        .await
        .expect("quit cleanup");

    eventually("the HUP-ignoring shell to be killed", || {
        pid_gone(started.shell_pid)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_that_exits_on_its_own_reports_its_exit_code() {
    let app = mock_app();
    let exits = Arc::new(StdMutex::new(Vec::<String>::new()));
    let sink = exits.clone();
    // Session ids start at 1 on a fresh state, so the event name is known
    // before the session exists and no exit can be missed.
    app.listen("pty:exit:1", move |event| {
        sink.lock().unwrap().push(event.payload().to_string());
    });
    let started = start(&app, "echo ready; exit 7").await;
    assert_eq!(started.id, 1);

    let seen = exits.clone();
    eventually("the exit event", move || !seen.lock().unwrap().is_empty()).await;
    assert_eq!(exits.lock().unwrap().as_slice(), [r#"{"exit_code":7}"#]);
    assert!(pid_gone(started.shell_pid), "the exited shell is reaped");
    assert!(
        String::from_utf8_lossy(&started.output.lock().unwrap()).contains("ready"),
        "output written before the exit is delivered"
    );

    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");
    eventually("the session to be released", || started.released()).await;
}
