// WI-RA7C.1 — a poisoned lock is recovered or refused loudly, never dropped in
// silence: the refusal helper logs, and a source-scan gate fails on every
// shape that turns a `PoisonError` into "nothing to do".
//
// WI-RA24.8 — a `std::fs::File::lock` call has no poison to drop; the gate
// sets it aside when its type or its receiver's binding proves it a file's
// (`lock_policy_file_lock.test.rs`), instead of forcing it out of its chain.

use super::lock_or_refuse;
use crate::source_scan::{production_files, Production};
use std::sync::{Mutex, PoisonError};

#[path = "lock_policy_file_lock.test.rs"]
mod file_lock;

/// Poison `mutex`: a thread panics while holding it. Shared by every test
/// that proves a site survives a poisoned lock.
pub(crate) fn poison<T: Send>(mutex: &Mutex<T>) {
    let panicked = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let _guard = mutex.lock().unwrap_or_else(PoisonError::into_inner);
                panic!("poisoning the mutex (expected by this test)");
            })
            .join()
    });
    assert!(
        panicked.is_err() && mutex.is_poisoned(),
        "premise: poisoned"
    );
}

/// A fresh mutex holding `value`, already poisoned.
pub(crate) fn poisoned<T: Send>(value: T) -> Mutex<T> {
    let mutex = Mutex::new(value);
    poison(&mutex);
    mutex
}

#[test]
fn a_healthy_lock_is_handed_out() {
    let mutex = Mutex::new(7);
    assert_eq!(lock_or_refuse(&mutex, "a counter").map(|g| *g), Some(7));
}

#[test]
fn a_poisoned_lock_is_refused_and_the_refusal_is_logged() {
    let mutex = poisoned(7);
    let mut refused = false;
    let lines = crate::peer_text::log_capture::captured_logs(|| {
        refused = lock_or_refuse(&mutex, "the test registry").is_none();
    });
    assert!(refused);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].contains("the test registry") && lines[0].contains("poisoned"));
}

// ── The gate ────────────────────────────────────────────────────────────────

/// The lock call every shape is built around, captured as `call`.
const CALL: &str = r"(?P<call>\.\s*(?:lock|read|write)\s*\(\s*\))";

/// Byte offsets in `code` (already blanked by `source_scan`) where a lock's
/// `Result` is consumed in a way that drops the poison silently. A call shown
/// to be `std::fs::File::lock` — no poison to drop — is not one.
fn silent_lock_sites(code: &str) -> Vec<usize> {
    let mut sites: Vec<usize> = lock_result_uses(code)
        .into_iter()
        .filter(|&(_, call)| !file_lock::is_file_lock(code, call))
        .map(|(site, _)| site)
        .collect();
    sites.sort_unstable();
    sites.dedup();
    sites
}

/// `(site, call)` for every place a lock's `Result` is consumed by one of the
/// silent shapes: where the shape starts, and where its lock call is.
fn lock_result_uses(code: &str) -> Vec<(usize, usize)> {
    let shapes = [
        // `if let Ok(g) = m.lock()`, `while let Ok(..)`, `let Ok(g) = m.lock() … else`
        format!(r"\blet\s+Ok\s*\([^=]*?\)\s*=\s*[^;{{]*?{CALL}"),
        // `match m.lock() { … }`
        format!(r"\bmatch\s+[^{{;]*?{CALL}[^{{;]*\{{"),
        // `m.lock().ok()`, `.map(..)`, `.unwrap_or(..)` … — poison becomes a default
        format!(
            r"{CALL}\s*\.\s*(?:ok|err|map|map_or|map_or_else|and_then|is_ok|is_err|unwrap_or|unwrap_or_default)\s*\("
        ),
    ];
    let mut uses: Vec<(usize, usize)> = shapes
        .iter()
        .flat_map(|shape| {
            regex::Regex::new(shape)
                .expect("gate regex")
                .captures_iter(code)
                .map(|found| site_and_call(&found))
                .collect::<Vec<_>>()
        })
        .collect();
    uses.extend(held_lock_uses(code));
    uses
}

/// `let r = m.lock();` and then `match r` / `if let Ok(..) = r`.
fn held_lock_uses(code: &str) -> Vec<(usize, usize)> {
    let held = regex::Regex::new(&format!(r"\blet\s+(?:mut\s+)?(\w+)\s*=\s*[^;]*?{CALL}\s*;"))
        .expect("held regex");
    held.captures_iter(code)
        .filter(|found| {
            let name = regex::escape(&found[1]);
            let after = &code[found.get(0).expect("match").end()..];
            regex::Regex::new(&format!(
                r"^\s*(?:match\s+{name}\b|if\s+let\s+(?:Ok|Err)\s*\([^)]*\)\s*=\s*{name}\b)"
            ))
            .expect("use regex")
            .is_match(after)
        })
        .map(|found| site_and_call(&found))
        .collect()
}

fn site_and_call(found: &regex::Captures) -> (usize, usize) {
    let site = found.get(0).expect("match").start();
    (site, found.name("call").expect("call group").start())
}

fn silent(source: &str) -> usize {
    let code = crate::source_scan::blank_test_items(
        &crate::source_scan::blank_comments_and_literals(source),
    );
    silent_lock_sites(&code).len()
}

#[test]
fn the_gate_sees_every_silent_shape() {
    for source in [
        "if let Ok(mut g) = CACHE.lock() { *g = 1; }",
        "let Ok(reg) = state.registry.lock() else { return false; };",
        "let Ok(policy) = state.ai_policy.lock().map(|p| *p) else { return; };",
        "while let Ok(g) = m.lock() { break; }",
        "match cell().write() { Ok(mut g) => *g = v, Err(e) => log::error!(\"{e}\") }",
        "match state.registry.lock() {\n Ok(reg) => reg,\n Err(_) => return None,\n }",
        "let x = SNAPSHOT.lock().ok().and_then(|s| s.get(0).cloned());",
        "let n = self.inner.lock().map(|r| r.len()).unwrap_or(0);",
        "let held = m\n    .lock()\n    .is_ok();",
        "let locked = state.registry.lock();\n match locked { Ok(r) => r, Err(_) => return }",
    ] {
        assert!(silent(source) >= 1, "not flagged: {source}");
    }
}

#[test]
fn the_gate_accepts_recovery_loud_refusal_and_non_lock_code() {
    for source in [
        "let g = CACHE.lock().unwrap_or_else(PoisonError::into_inner);",
        "let g = CACHE.lock().unwrap_or_else(|p| p.into_inner());",
        "let reg = state.registry.lock().map_err(lock_failure)?;",
        "let policy = state.ai_policy.lock().map_err(lock_failure).map(|p| *p)?;",
        "let guard = bridge.lock().await;",
        "let sessions = state.sessions.read().await;",
        "let Some(reg) = lock_or_refuse(&state.registry, \"browser registry\") else { return; };",
        "if let Ok(n) = file.read(&mut buf) { total += n; }",
        "match &*self.lock_state() { State::Gone(c) => *c, _ => 0 }",
        "// if let Ok(g) = CACHE.lock() {}",
        "let s = \"if let Ok(g) = CACHE.lock() {}\";",
        "#[cfg(test)]\nfn probe() -> bool { CACHE.lock().is_ok() }",
    ] {
        assert_eq!(silent(source), 0, "flagged: {source}");
    }
}

#[test]
fn the_gate_accepts_a_file_lock_known_by_its_binding_or_its_unit_payload() {
    for source in [
        // The writer-id repair: an `.open(..)` chain's closure parameter.
        "let lock = fs::OpenOptions::new()\n    .create(true)\n    .truncate(false)\n    .write(true)\n    .open(dir.join(\"coherence-writer-id.lock\"))\n    .and_then(|lock| lock.lock().map(|()| lock))\n    .map_err(|e| format!(\"writer-id lock: {e}\"))?;",
        "let f = File::options().read(true).open(p).and_then(|f| f.lock().map(|_| f))?;",
        "let f = File::open(p).and_then(|f| f.lock().map(|_| f))?;",
        "let f = fs::File::open(p)?; let held = f.lock().is_ok();",
        "let mut f = OpenOptions::new().write(true).open(p).map_err(|e| e.to_string())?;\nmatch f.lock() { Ok(()) => {} Err(e) => return Err(e.to_string()) }",
        "let f: std::fs::File = make(); let held = f.lock().is_ok();",
        "fn hold(file: &fs::File) -> bool { file.lock().is_ok() }",
        "fn hold(n: u8, mut file: std::fs::File) -> bool { file.lock().is_ok() }",
        // A unit payload proves the type whatever the receiver: a guard is never `()`.
        "let held = self.file.lock().map(|()| true).unwrap_or(false);",
        "if let Ok(()) = self.file.lock() { held = true; }",
    ] {
        assert_eq!(silent(source), 0, "flagged: {source}");
    }
}

#[test]
fn the_gate_still_sees_a_mutex_beside_a_file_lock() {
    for (source, sites) in [
        // A same-named binding that is not a file.
        ("let lock = Mutex::new(0); if let Ok(g) = lock.lock() {}", 1),
        // A field's type is unknown.
        ("let file = File::open(p)?; let g = state.file.lock().ok();", 1),
        // The nearest binding decides: shadowed by a mutex, a loop or an arm.
        ("let f = File::open(p)?; let f = Mutex::new(f); let g = f.lock().ok();", 1),
        ("let f = File::open(p)?; for f in mutexes { let g = f.lock().ok(); }", 1),
        ("let f = File::open(p)?; match slot { Some(f) => f.lock().is_ok(), None => false };", 1),
        // Built from a file, but not a file.
        ("let f = File::open(p).map(Mutex::new)?; let g = f.lock().ok();", 1),
        ("let f: Mutex<File> = Mutex::new(file); let g = f.lock().ok();", 1),
        ("let f = Mutex::new(File::open(p)?); let g = f.lock().ok();", 1),
        // A closure parameter is out of scope after its call closes.
        ("let f = Mutex::new(0);\nlet x = File::options().open(p).and_then(|f| f.lock().map(|_| f));\nlet g = f.lock().ok();", 1),
        // `Ok(())` matches the mapped value here, not the guard.
        ("if let Ok(()) = m.lock().map(|mut g| *g = 1) {}", 2),
        // Only `.lock()` can be a file's; `.read()` and `.write()` stay RwLock calls.
        ("let file = File::open(p)?; if let Ok(g) = file.read() {}", 1),
    ] {
        assert_eq!(silent(source), sites, "{source}");
    }
}

#[test]
fn no_production_code_drops_a_poisoned_lock_silently() {
    let files: Vec<Production> = production_files();
    let offenders: Vec<String> = files
        .iter()
        .flat_map(|file| {
            silent_lock_sites(&file.code)
                .into_iter()
                .map(|at| file.locate(at))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "{} site(s) drop a poisoned lock silently — recover with \
         `unwrap_or_else(PoisonError::into_inner)` or refuse loudly with \
         `lock_policy::lock_or_refuse` / `map_err` (see lock_policy.rs):\n{}",
        offenders.len(),
        offenders.join("\n")
    );
}
