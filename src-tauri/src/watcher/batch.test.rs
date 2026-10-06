// WI-RA11.1 — watcher batching: a burst of changes reaches the frontend as a
// few bounded batches, in order, with nothing lost and nothing emitted late.

use super::*;
use std::sync::mpsc::channel;

fn change(kind: FsChangeKind, paths: &[&str]) -> FsChange {
    FsChange {
        kind,
        paths: paths.iter().map(|p| p.to_string()).collect(),
    }
}

fn signal(kind: FsChangeKind, paths: &[&str]) -> Signal {
    Signal::Change(change(kind, paths))
}

fn config(window: Duration, max_changes: usize) -> BatchConfig {
    BatchConfig {
        watch_id: "main".to_string(),
        root_path: "/ws".to_string(),
        window,
        max_changes,
    }
}

/// A window no test waits out: the loop leaves it only because the batch
/// filled or the watcher was dropped.
const NEVER_ELAPSES: Duration = Duration::from_secs(3600);

/// Queue `queued`, run the loop over it, and return the first `expected`
/// batches. The watcher is then dropped, and anything the loop emitted beyond
/// `expected` fails the test.
fn batches_from(queued: Vec<Signal>, config: BatchConfig, expected: usize) -> Vec<FsChangeBatch> {
    let (signals, receiver) = signal_queue();
    for queued_signal in queued {
        signals.send(queued_signal).expect("queue has room");
    }
    let (emitted, batches) = channel();
    let worker = std::thread::spawn(move || {
        run_batch_loop(&receiver, &config, |batch| {
            emitted.send(batch).expect("test is still collecting");
        });
    });
    let collected: Vec<FsChangeBatch> = (0..expected)
        .map(|_| {
            batches
                .recv_timeout(Duration::from_secs(30))
                .expect("the loop must emit the expected batch")
        })
        .collect();
    drop(signals);
    worker.join().expect("batch loop must not panic");
    assert_eq!(
        batches.try_iter().count(),
        0,
        "the loop emitted more batches than expected"
    );
    collected
}

// ── PendingBatch ─────────────────────────────────────────────────────────────

#[test]
fn an_empty_batch_is_not_emitted() {
    let mut pending = PendingBatch::default();
    assert_eq!(pending.take("main", "/ws"), None);
}

#[test]
fn a_repeat_of_the_last_change_to_a_path_is_dropped() {
    // FSEvents reports one write several times; the frontend needs it once.
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));

    let batch = pending.take("main", "/ws").expect("one change collected");
    assert_eq!(
        batch.changes,
        vec![change(FsChangeKind::Modify, &["/ws/a.md"])]
    );
}

#[test]
fn a_different_kind_in_between_makes_the_same_change_news_again() {
    // create → remove → create: dropping the second create would leave the
    // frontend believing the file is gone.
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Create, &["/ws/a.md"]));
    pending.push(signal(FsChangeKind::Remove, &["/ws/a.md"]));
    pending.push(signal(FsChangeKind::Create, &["/ws/a.md"]));

    let batch = pending
        .take("main", "/ws")
        .expect("three changes collected");
    assert_eq!(
        batch.changes,
        vec![
            change(FsChangeKind::Create, &["/ws/a.md"]),
            change(FsChangeKind::Remove, &["/ws/a.md"]),
            change(FsChangeKind::Create, &["/ws/a.md"]),
        ]
    );
}

#[test]
fn changes_to_other_paths_do_not_hide_a_repeat() {
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));
    pending.push(signal(FsChangeKind::Modify, &["/ws/b.md"]));
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));

    let batch = pending.take("main", "/ws").expect("two changes collected");
    assert_eq!(
        batch.changes,
        vec![
            change(FsChangeKind::Modify, &["/ws/a.md"]),
            change(FsChangeKind::Modify, &["/ws/b.md"]),
        ]
    );
}

#[test]
fn a_rename_pair_repeats_only_when_both_paths_are_untouched_since() {
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Rename, &["/ws/old.md", "/ws/new.md"]));
    pending.push(signal(FsChangeKind::Rename, &["/ws/old.md", "/ws/new.md"]));
    assert_eq!(pending.len(), 1, "an identical pair is a repeat");

    // The new name is written, then the same pair is reported again: the
    // second report is no longer the last word on `/ws/new.md`.
    pending.push(signal(FsChangeKind::Modify, &["/ws/new.md"]));
    pending.push(signal(FsChangeKind::Rename, &["/ws/old.md", "/ws/new.md"]));
    assert_eq!(pending.len(), 3);
}

#[test]
fn a_single_path_change_is_not_a_repeat_of_a_pair_that_touched_it() {
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Rename, &["/ws/a.md", "/ws/b.md"]));
    pending.push(signal(FsChangeKind::Rename, &["/ws/a.md"]));
    assert_eq!(pending.len(), 2);
}

#[test]
fn paths_are_compared_exactly_including_non_ascii_names() {
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Modify, &["/ws/笔记/第一章.md"]));
    pending.push(signal(FsChangeKind::Modify, &["/ws/笔记/第一章.md"]));
    pending.push(signal(FsChangeKind::Modify, &["/ws/笔记/第二章.md"]));
    assert_eq!(pending.len(), 2);
}

#[test]
fn a_rescan_is_carried_alongside_the_changes_already_collected() {
    // The explicit changes stay useful (an open document still reloads); the
    // flag adds that they may not be the whole story.
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));
    pending.push(Signal::Rescan);
    pending.push(signal(FsChangeKind::Create, &["/ws/b.md"]));

    let batch = pending.take("main", "/ws").expect("a rescan is a batch");
    assert!(batch.rescan);
    assert_eq!(batch.changes.len(), 2);
}

#[test]
fn a_rescan_alone_is_a_batch() {
    let mut pending = PendingBatch::default();
    pending.push(Signal::Rescan);
    assert_eq!(
        pending.take("main", "/ws"),
        Some(FsChangeBatch {
            watch_id: "main".to_string(),
            root_path: "/ws".to_string(),
            changes: vec![],
            rescan: true,
        })
    );
}

#[test]
fn taking_a_batch_starts_the_next_one_from_nothing() {
    let mut pending = PendingBatch::default();
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));
    pending.push(Signal::Rescan);
    pending.take("main", "/ws").expect("first batch");

    assert_eq!(pending.take("main", "/ws"), None);
    // The same change in the NEXT batch is news: the frontend was told about
    // the earlier one a window ago.
    pending.push(signal(FsChangeKind::Modify, &["/ws/a.md"]));
    let next = pending.take("main", "/ws").expect("second batch");
    assert_eq!(next.changes.len(), 1);
    assert!(!next.rescan);
}

// ── wire shape ───────────────────────────────────────────────────────────────

#[test]
fn the_batch_serializes_to_the_shape_the_frontend_reads() {
    let batch = FsChangeBatch {
        watch_id: "doc-2".to_string(),
        root_path: "/Users/test/notes".to_string(),
        changes: vec![
            change(FsChangeKind::Create, &["/Users/test/notes/a.md"]),
            change(
                FsChangeKind::Rename,
                &["/Users/test/notes/a.md", "/Users/test/notes/b.md"],
            ),
            change(FsChangeKind::Modify, &["/Users/test/notes/b.md"]),
            change(FsChangeKind::Remove, &["/Users/test/notes/b.md"]),
        ],
        rescan: true,
    };
    assert_eq!(
        serde_json::to_value(&batch).unwrap(),
        serde_json::json!({
            "watchId": "doc-2",
            "rootPath": "/Users/test/notes",
            "changes": [
                { "kind": "create", "paths": ["/Users/test/notes/a.md"] },
                { "kind": "rename", "paths": ["/Users/test/notes/a.md", "/Users/test/notes/b.md"] },
                { "kind": "modify", "paths": ["/Users/test/notes/b.md"] },
                { "kind": "remove", "paths": ["/Users/test/notes/b.md"] },
            ],
            "rescan": true,
        })
    );
}

// ── run_batch_loop ───────────────────────────────────────────────────────────

#[test]
fn changes_that_arrive_within_one_window_are_emitted_as_one_batch() {
    let queued = vec![
        signal(FsChangeKind::Create, &["/ws/a.md"]),
        signal(FsChangeKind::Modify, &["/ws/b.md"]),
        signal(FsChangeKind::Remove, &["/ws/c.md"]),
    ];
    // A zero window still drains everything already queued before it flushes.
    let batches = batches_from(queued, config(Duration::ZERO, MAX_BATCH_CHANGES), 1);

    assert_eq!(batches[0].watch_id, "main");
    assert_eq!(batches[0].root_path, "/ws");
    assert_eq!(
        batches[0].changes,
        vec![
            change(FsChangeKind::Create, &["/ws/a.md"]),
            change(FsChangeKind::Modify, &["/ws/b.md"]),
            change(FsChangeKind::Remove, &["/ws/c.md"]),
        ]
    );
    assert!(!batches[0].rescan);
}

#[test]
fn a_full_batch_is_emitted_without_waiting_out_the_window() {
    let queued: Vec<Signal> = (0..5)
        .map(|i| signal(FsChangeKind::Create, &[&format!("/ws/{i}.md")]))
        .collect();
    // Five changes at two per batch: two full batches leave at once. The
    // fifth is still inside a window that never elapses when the watcher is
    // dropped, so it is not delivered.
    let batches = batches_from(queued, config(NEVER_ELAPSES, 2), 2);

    let sizes: Vec<usize> = batches.iter().map(|b| b.changes.len()).collect();
    assert_eq!(sizes, vec![2, 2], "no batch may exceed the bound");
    assert_eq!(batches[0].changes[0].paths, vec!["/ws/0.md"]);
    assert_eq!(batches[1].changes[1].paths, vec!["/ws/3.md"]);
}

#[test]
fn a_burst_far_larger_than_the_bound_loses_nothing() {
    let total = MAX_BATCH_CHANGES * 3;
    let (signals, receiver) = signal_queue();
    let (emitted, batches) = channel();
    let worker = std::thread::spawn(move || {
        run_batch_loop(
            &receiver,
            &config(NEVER_ELAPSES, MAX_BATCH_CHANGES),
            |batch| emitted.send(batch).expect("test is still collecting"),
        );
    });
    // More signals than the queue holds: `send` blocks until the loop drains.
    for i in 0..total {
        signals
            .send(signal(FsChangeKind::Create, &[&format!("/ws/{i}.md")]))
            .expect("loop is alive");
    }
    let collected: Vec<FsChangeBatch> = (0..3)
        .map(|_| {
            batches
                .recv_timeout(Duration::from_secs(30))
                .expect("full batch")
        })
        .collect();
    drop(signals);
    worker.join().expect("batch loop must not panic");

    let seen: Vec<String> = collected
        .iter()
        .flat_map(|b| b.changes.iter().flat_map(|c| c.paths.clone()))
        .collect();
    let expected: Vec<String> = (0..total).map(|i| format!("/ws/{i}.md")).collect();
    assert_eq!(seen, expected);
    assert!(collected
        .iter()
        .all(|b| b.changes.len() == MAX_BATCH_CHANGES));
}

#[test]
fn a_rescan_signal_reaches_the_frontend_in_the_batch() {
    let queued = vec![Signal::Rescan];
    let batches = batches_from(queued, config(Duration::ZERO, MAX_BATCH_CHANGES), 1);
    assert!(batches[0].rescan);
    assert!(batches[0].changes.is_empty());
}

#[test]
fn nothing_is_emitted_for_a_watcher_that_is_gone() {
    // Two changes sit inside a window that never elapses; the watcher is then
    // dropped. Delivering them late would describe a root nobody is watching.
    let queued = vec![
        signal(FsChangeKind::Modify, &["/ws/a.md"]),
        signal(FsChangeKind::Modify, &["/ws/b.md"]),
    ];
    let batches = batches_from(queued, config(NEVER_ELAPSES, MAX_BATCH_CHANGES), 0);
    assert!(batches.is_empty());
}

#[test]
fn the_queue_is_bounded() {
    let (signals, _receiver) = signal_queue();
    for _ in 0..QUEUE_CAPACITY {
        signals
            .try_send(Signal::Rescan)
            .expect("room up to the capacity");
    }
    assert!(
        signals.try_send(Signal::Rescan).is_err(),
        "the queue must refuse to grow past its capacity"
    );
}
