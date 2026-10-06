//! Window-leak checks shared by the window-producing scenarios.
//!
//! Purpose: a scenario proves it leaked no window by comparing the app's window
//! set after its renders with the set before them. Both ends of that comparison
//! must be taken when no earlier renderer window is still closing — the
//! renderer settles its sink and THEN closes its window, so a close can still
//! be in flight when the next scenario starts.
//!
//! @coordinates-with scenarios.rs — `sequential` and `concurrent` call these
//! @module bin/pdf_smoke/window_check

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use tauri::Manager;

/// The label prefix of a renderer's hidden window. It mirrors the private
/// `LABEL_PREFIX` of each platform renderer under `pdf_export/renderer/`.
const RENDER_LABEL_PREFIX: &str = "pdf-render-";

/// How long a window close may take before it counts as a leak.
const SETTLE_BOUND: Duration = Duration::from_secs(10);

/// The set of window labels the app currently holds.
///
/// A COUNT cannot see the failure this is here for. The old check compared
/// `after > before`, so a renderer that closed one of the baseline windows
/// while leaking a replacement of its own reported `after == before` and
/// passed — and a renderer that simply destroyed a pre-existing window made
/// `after < before` and passed too. Identity distinguishes all three.
fn window_labels(app: &tauri::AppHandle) -> BTreeSet<String> {
    app.webview_windows().into_keys().collect()
}

/// Poll until `done` holds for the window set, or the bound passes.
async fn poll_windows(
    app: &tauri::AppHandle,
    done: impl Fn(&BTreeSet<String>) -> bool,
) -> BTreeSet<String> {
    let deadline = Instant::now() + SETTLE_BOUND;
    let mut labels = window_labels(app);
    while !done(&labels) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        labels = window_labels(app);
    }
    labels
}

/// The window set to compare against, taken once no renderer window remains.
///
/// Snapshotting immediately captured an earlier scenario's renderer window
/// mid-close (seen on Windows, where closes are slower): it then finished
/// closing and the scenario reported it "lost". A renderer window still open
/// after the bound is an earlier scenario's leak — reported here, as a failure,
/// and kept in the baseline so it is not blamed on this scenario too.
pub async fn settled_baseline(name: &str, app: &tauri::AppHandle) -> (BTreeSet<String>, usize) {
    let is_renderer = |label: &&String| label.starts_with(RENDER_LABEL_PREFIX);
    let labels = poll_windows(app, |labels| !labels.iter().any(|l| is_renderer(&l))).await;
    let stale: Vec<&String> = labels.iter().filter(is_renderer).collect();
    if stale.is_empty() {
        return (labels, 0);
    }
    println!("SMOKE {name} FAIL baseline: renderer windows still open after 10s: {stale:?}");
    (labels, 1)
}

/// Wait for the window set to return to `before`, then report the difference.
///
/// The caller resumes before its last renderer's close has been processed, so
/// comparing immediately measures a close in flight, not a leak. The contract
/// is that windows return to the baseline promptly, so poll for that with a
/// bound: if they never do, it is a real leak and this still fails.
pub async fn windows_returned_to(
    name: &str,
    app: &tauri::AppHandle,
    before: &BTreeSet<String>,
) -> usize {
    let after = poll_windows(app, |labels| labels == before).await;
    if after == *before {
        // Printed, not silent: the transcript is what a caller asserts on, and
        // a check that says nothing when it passes is indistinguishable from
        // one that never ran.
        println!(
            "SMOKE {name} windows PASS back to the {} at the start",
            before.len()
        );
        return 0;
    }
    let added: Vec<&String> = after.difference(before).collect();
    let removed: Vec<&String> = before.difference(&after).collect();
    println!("SMOKE {name} FAIL windows after 10s: leaked {added:?}, lost {removed:?}");
    1
}
