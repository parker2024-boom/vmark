//! WI-RA7.7 — test support: capture what a piece of code writes to the log.
//!
//! "A webview string cannot forge a log line" is a statement about the line
//! that reaches the logger, so the tests that pin it read that line rather
//! than re-deriving it from the format string.
//!
//! The `log` crate has one process-wide logger. This one is installed on first
//! use and records only on the thread that asked: every other test thread sees
//! a logger that drops its records, exactly as with none installed. Capturing
//! is therefore safe under the parallel test runner, provided the code under
//! test logs on the calling thread.

use std::cell::RefCell;
use std::sync::Once;

thread_local! {
    /// The lines captured on this thread, while a capture is open.
    static CAPTURED: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

struct ThreadCapture;

impl log::Log for ThreadCapture {
    fn enabled(&self, _metadata: &log::Metadata<'_>) -> bool {
        CAPTURED.with(|captured| captured.borrow().is_some())
    }

    fn log(&self, record: &log::Record<'_>) {
        CAPTURED.with(|captured| {
            if let Some(lines) = captured.borrow_mut().as_mut() {
                lines.push(record.args().to_string());
            }
        });
    }

    fn flush(&self) {}
}

static LOGGER: ThreadCapture = ThreadCapture;
static INSTALL: Once = Once::new();

/// Run `body` and return every message it logged on this thread, in order,
/// at any level.
pub(crate) fn captured_logs(body: impl FnOnce()) -> Vec<String> {
    INSTALL.call_once(|| {
        log::set_logger(&LOGGER)
            .expect("another logger is installed in the test binary; log capture cannot work");
        log::set_max_level(log::LevelFilter::Trace);
    });
    CAPTURED.with(|captured| *captured.borrow_mut() = Some(Vec::new()));
    body();
    CAPTURED
        .with(|captured| captured.borrow_mut().take())
        .unwrap_or_default()
}

#[test]
fn a_capture_returns_what_was_logged_on_this_thread_in_order() {
    let lines = captured_logs(|| {
        log::info!("first {}", 1);
        log::debug!("second");
    });
    assert_eq!(lines, vec!["first 1".to_string(), "second".to_string()]);
}

#[test]
fn nothing_is_recorded_outside_a_capture_or_on_another_thread() {
    log::info!("before any capture on this thread");
    let lines = captured_logs(|| {
        std::thread::scope(|scope| {
            scope.spawn(|| log::info!("from another thread"));
        });
        log::info!("mine");
    });
    assert_eq!(lines, vec!["mine".to_string()]);
}
