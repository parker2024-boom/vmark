// WI-RA14B.3 — the short PTY commands, driven as the frontend calls them on a
// mock runtime: an unknown pid is `not-found` (an ordinary race after
// `pty:exit`, never a fault), input reaches the shell, a resize is clamped to
// at least one cell, a kill ends the shell but keeps the session until
// `pty_close`, and a resume wakes a paused reader.
//
// Every wait is a condition polled against a deadline.

use super::test_support::{pid_gone, spawn_sh, DEADLINE};
use super::*;
use crate::command_error::ErrorCode;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::test::MockRuntime;

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
    output: Arc<StdMutex<Vec<u8>>>,
}

impl Started {
    fn saw(&self, text: &str) -> bool {
        String::from_utf8_lossy(&self.output.lock().unwrap()).contains(text)
    }
}

/// Register `/bin/sh -c <script>` and start its reader through `pty_start`,
/// returning once the script printed `ready`.
async fn start(app: &tauri::App<MockRuntime>, script: &str) -> Started {
    let session = Arc::new(spawn_sh("main", script));
    let shell_pid = session.child.pid().expect("shell pid");
    let state = app.state::<PtyState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().await.insert(id, session);

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
    let started = Started {
        id,
        shell_pid,
        output,
    };
    eventually("the shell to print ready", || started.saw("ready")).await;
    started
}

async fn size_of(app: &tauri::App<MockRuntime>, id: u32) -> (u16, u16) {
    let session = get_session(&app.state::<PtyState>(), id)
        .await
        .expect("session");
    let size = session.master.lock().unwrap().get_size().expect("size");
    (size.cols, size.rows)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_pid_is_not_found_and_closing_it_is_a_no_op() {
    let app = mock_app();
    let state = || app.state::<PtyState>();
    let missing = 4_000_000;

    let codes = [
        pty_write(missing, "x".into(), state())
            .await
            .unwrap_err()
            .code(),
        pty_resize(missing, 80, 24, state())
            .await
            .unwrap_err()
            .code(),
        pty_kill(missing, state()).await.unwrap_err().code(),
        pty_pause(missing, state()).await.unwrap_err().code(),
        pty_resume(missing, state()).await.unwrap_err().code(),
    ];

    assert!(codes.iter().all(|c| *c == ErrorCode::NotFound), "{codes:?}");
    pty_close(missing, state())
        .await
        .expect("closing nothing is fine");
}

#[tokio::test(flavor = "multi_thread")]
async fn written_input_reaches_the_shell() {
    let app = mock_app();
    let started = start(&app, "echo ready; read line; echo \"got:$line\"; sleep 600").await;

    pty_write(started.id, "héllo 世界\n".into(), app.state::<PtyState>())
        .await
        .expect("write");

    eventually("the shell to echo the input", || {
        started.saw("got:héllo 世界")
    })
    .await;
    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resize_is_applied_and_a_zero_dimension_becomes_one() {
    let app = mock_app();
    let started = start(&app, "echo ready; sleep 600").await;

    pty_resize(started.id, 132, 43, app.state::<PtyState>())
        .await
        .expect("resize");
    assert_eq!(size_of(&app, started.id).await, (132, 43));

    pty_resize(started.id, 0, 0, app.state::<PtyState>())
        .await
        .expect("a zero size is clamped, not refused");
    assert_eq!(size_of(&app, started.id).await, (1, 1));

    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_ends_the_shell_but_the_session_stays_until_close() {
    let app = mock_app();
    let started = start(&app, "echo ready; sleep 600").await;

    pty_kill(started.id, app.state::<PtyState>())
        .await
        .expect("kill");

    eventually("the shell to be gone", || pid_gone(started.shell_pid)).await;
    // Still addressable: the frontend closes it after the exit event.
    pty_pause(started.id, app.state::<PtyState>())
        .await
        .expect("session still in the map");
    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");
    let after = pty_pause(started.id, app.state::<PtyState>()).await;
    assert_eq!(after.unwrap_err().code(), ErrorCode::NotFound);
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_wakes_a_paused_reader() {
    let app = mock_app();
    let started = start(
        &app,
        "echo ready; while read line; do echo \"got:$line\"; done",
    )
    .await;

    pty_pause(started.id, app.state::<PtyState>())
        .await
        .expect("pause");
    // The reader delivers what it already read, then sleeps on the pause.
    pty_write(started.id, "first\n".into(), app.state::<PtyState>())
        .await
        .expect("write");
    pty_resume(started.id, app.state::<PtyState>())
        .await
        .expect("resume");
    pty_write(started.id, "second\n".into(), app.state::<PtyState>())
        .await
        .expect("write");

    // A resume that did not wake the reader would leave this output unread.
    eventually("output after the resume", || started.saw("got:second")).await;
    assert!(started.saw("got:first"));
    pty_close(started.id, app.state::<PtyState>())
        .await
        .expect("close");
}
