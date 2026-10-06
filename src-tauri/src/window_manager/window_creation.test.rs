//! WI-RA7.1 — a fixed window label is checked and built as one step: two
//! callers racing for one label produce one window.
//!
//! Tauri's builder checks the label on the calling thread and registers it
//! unconditionally after the native window exists, so two concurrent builds of
//! one label both succeed and the second registration replaces the first. The
//! tests drive `ensure_window` from several threads on a mock app and count
//! the `tauri://window-created` events the runtime emits per build.

// `tauri::test` does not exist on Windows (see Cargo.toml's target-specific
// dev-dependency); every mock-runtime suite in this crate is gated to match.
#![cfg(not(target_os = "windows"))]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};

use tauri::test::MockRuntime;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{ensure_window, Ensured};

fn mock_app() -> tauri::App<MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

/// The plainest possible window under `label`.
fn plain(app: &AppHandle<MockRuntime>, label: &str) -> tauri::Result<WebviewWindow<MockRuntime>> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .visible(false)
        .build()
}

/// Count the native windows built under `label` from now on: Tauri emits
/// `tauri://window-created` once per successful `build()`.
fn count_builds(app: &tauri::App<MockRuntime>, label: &'static str) -> Arc<AtomicUsize> {
    let built = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&built);
    app.listen_any("tauri://window-created", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).expect("a JSON payload");
        if payload["label"] == label {
            seen.fetch_add(1, Ordering::SeqCst);
        }
    });
    built
}

fn kind(outcome: &tauri::Result<Ensured<MockRuntime>>) -> &'static str {
    match outcome {
        Ok(Ensured::Created(_)) => "created",
        Ok(Ensured::Existing(_)) => "existing",
        Ok(Ensured::Pending) => "pending",
        Err(_) => "error",
    }
}

#[test]
fn an_absent_label_is_built_and_reported_as_created() {
    let app = mock_app();
    let built = count_builds(&app, "settings");

    let outcome = ensure_window(app.handle(), "settings", plain);

    assert_eq!(kind(&outcome), "created");
    assert!(app.get_webview_window("settings").is_some());
    assert_eq!(built.load(Ordering::SeqCst), 1);
}

#[test]
fn a_live_label_is_returned_without_building() {
    let app = mock_app();
    plain(app.handle(), "settings").expect("the first window");
    let built = count_builds(&app, "settings");

    let outcome = ensure_window(app.handle(), "settings", |_, _| {
        panic!("a live label must not be built again")
    });

    assert_eq!(kind(&outcome), "existing");
    let Ok(Ensured::Existing(window)) = outcome else {
        unreachable!("checked above")
    };
    assert_eq!(window.label(), "settings");
    assert_eq!(built.load(Ordering::SeqCst), 0);
}

/// The interleaving the defect needs, made deterministic: the first caller is
/// held inside its build — past the existence check, before the label is
/// registered — while a second caller asks for the same label.
#[test]
fn a_second_caller_arriving_mid_build_does_not_build_the_label_again() {
    let app = mock_app();
    let built = count_builds(&app, "settings");
    let (entered, first_is_building) = mpsc::channel();
    let (release, may_finish) = mpsc::channel::<()>();

    let handle = app.handle().clone();
    let first = std::thread::spawn(move || {
        ensure_window(&handle, "settings", move |app, label| {
            entered.send(()).expect("the test is waiting");
            may_finish.recv().expect("the test releases the build");
            plain(app, label)
        })
    });
    first_is_building
        .recv()
        .expect("the first build was entered");

    let second = ensure_window(app.handle(), "settings", |_, _| {
        panic!("the label is being built by the first caller")
    });
    assert_eq!(kind(&second), "pending");

    release.send(()).expect("the first build is waiting");
    let first = first.join().expect("the first caller finished");
    assert_eq!(kind(&first), "created");

    // The claim is gone with the build, so a later caller sees the window.
    let third = ensure_window(app.handle(), "settings", |_, _| {
        panic!("the label is live now")
    });
    assert_eq!(kind(&third), "existing");
    assert_eq!(built.load(Ordering::SeqCst), 1, "one native window");
}

#[test]
fn many_callers_racing_for_one_label_build_exactly_one_window() {
    const CALLERS: usize = 16;
    // Many apps, because a race is a matter of schedule: one round can pass by
    // luck, fifty in a row cannot.
    for round in 0..50 {
        let app = mock_app();
        let built = count_builds(&app, "main");
        let start = Arc::new(Barrier::new(CALLERS));

        let callers: Vec<_> = (0..CALLERS)
            .map(|_| {
                let handle = app.handle().clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    kind(&ensure_window(&handle, "main", plain))
                })
            })
            .collect();
        let outcomes: Vec<&str> = callers
            .into_iter()
            .map(|caller| caller.join().expect("caller finished"))
            .collect();

        assert_eq!(
            outcomes.iter().filter(|kind| **kind == "created").count(),
            1,
            "round {round}: {outcomes:?}"
        );
        assert!(
            outcomes.iter().all(|kind| *kind != "error"),
            "round {round}: losing the race is not an error: {outcomes:?}"
        );
        assert_eq!(built.load(Ordering::SeqCst), 1, "round {round}");
    }
}

#[test]
fn a_failed_build_releases_the_label_for_the_next_caller() {
    let app = mock_app();

    let failed = ensure_window(app.handle(), "settings", |_, _| {
        Err(tauri::Error::WindowNotFound)
    });
    assert_eq!(kind(&failed), "error");

    let retried = ensure_window(app.handle(), "settings", plain);
    assert_eq!(kind(&retried), "created");
}

#[test]
fn a_label_mid_build_does_not_hold_up_a_different_label() {
    let app = mock_app();
    let (entered, first_is_building) = mpsc::channel();
    let (release, may_finish) = mpsc::channel::<()>();

    let handle = app.handle().clone();
    let first = std::thread::spawn(move || {
        ensure_window(&handle, "settings", move |app, label| {
            entered.send(()).expect("the test is waiting");
            may_finish.recv().expect("the test releases the build");
            plain(app, label)
        })
    });
    first_is_building
        .recv()
        .expect("the first build was entered");

    let other = ensure_window(app.handle(), "pdf-export", plain);
    assert_eq!(kind(&other), "created");

    release.send(()).expect("the first build is waiting");
    assert_eq!(kind(&first.join().expect("finished")), "created");
}

#[test]
fn a_label_mid_build_in_one_app_is_free_in_another() {
    // Claims are per app: every mock app in this test binary uses the same
    // fixed labels, on its own threads, at the same time.
    let busy = mock_app();
    let other = mock_app();
    let (entered, first_is_building) = mpsc::channel();
    let (release, may_finish) = mpsc::channel::<()>();

    let handle = busy.handle().clone();
    let first = std::thread::spawn(move || {
        ensure_window(&handle, "settings", move |app, label| {
            entered.send(()).expect("the test is waiting");
            may_finish.recv().expect("the test releases the build");
            plain(app, label)
        })
    });
    first_is_building
        .recv()
        .expect("the first build was entered");

    assert_eq!(
        kind(&ensure_window(other.handle(), "settings", plain)),
        "created"
    );

    release.send(()).expect("the first build is waiting");
    assert_eq!(kind(&first.join().expect("finished")), "created");
}

#[test]
fn the_builder_is_handed_the_label_and_a_refused_one_is_an_error_not_a_claim() {
    let app = mock_app();
    // Tauri accepts alphanumerics and `-/:_` in a label; a space is refused.
    let refused = "doc 文档";

    let outcome = ensure_window(app.handle(), refused, |app, label| {
        assert_eq!(label, "doc 文档");
        plain(app, label)
    });
    assert_eq!(kind(&outcome), "error");
    assert!(app.get_webview_window(refused).is_none());

    // The label was released with the failure: the next caller builds again
    // rather than being told a build is under way.
    let again = ensure_window(app.handle(), refused, plain);
    assert_eq!(kind(&again), "error");
}
