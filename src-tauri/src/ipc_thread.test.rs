// WI-RA11.5 — commands that touch the disk, the user database or other
// processes must not run on the IPC thread. A non-`async` Tauri command runs
// inline on the thread that delivered the message, so a slow disk, a network
// home directory or a stuck `where.exe` stalls every IPC call behind it.
//
// Source scan: each named command must be an `async fn` that hands its work to
// the blocking pool, directly or through a helper that does.
//
// WI-RA7C.4 — a sync fn registered as `#[tauri::command(async)]` is no longer
// accepted here. That attribute moves the call off the IPC thread and onto a
// worker of the async runtime, where blocking work stalls every task that
// worker would have run. Where other Rust code needs the same work
// synchronously, the blocking function has its own name and the command wraps
// it (`shell_env::default_shell` / `get_default_shell`).

use std::path::Path;

/// (file, command) pairs that do blocking work.
const BLOCKING_COMMANDS: &[(&str, &str)] = &[
    ("workspace/mod.rs", "read_workspace_config"),
    ("workspace/mod.rs", "write_workspace_config"),
    ("watcher.rs", "start_watching"),
    ("shell_env.rs", "get_login_shell_path"),
    ("shell_env.rs", "get_default_shell"),
    ("shell_env.rs", "list_available_shells"),
];

/// Calls that move work onto the blocking pool.
const OFF_THREAD: &[&str] = &["spawn_blocking(", "config_io("];

fn source(file: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The declaration of `fn name` up to the brace that closes its body.
fn function(source: &str, name: &str) -> Option<String> {
    let start = source.find(&format!("fn {name}"))?;
    let decl_start = source[..start].rfind('\n').map_or(0, |i| i + 1);
    let open = start + source[start..].find('{')?;
    let mut depth = 0usize;
    for (i, ch) in source[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(source[decl_start..=open + i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

#[test]
fn blocking_commands_are_async_and_leave_the_ipc_thread() {
    let mut offenders = Vec::new();
    for (file, name) in BLOCKING_COMMANDS {
        let text = source(file);
        let body = function(&text, name).unwrap_or_else(|| panic!("{file}: no fn {name}"));
        let is_async = body
            .lines()
            .next()
            .is_some_and(|line| line.contains("async fn"));
        let off_thread = OFF_THREAD.iter().any(|call| body.contains(call));
        if !(is_async && off_thread) {
            offenders.push(format!("{file}::{name}"));
        }
    }
    assert!(
        offenders.is_empty(),
        "commands doing blocking work on the IPC thread or an async worker: {offenders:?}"
    );
}

#[test]
fn the_workspace_config_helper_itself_uses_the_blocking_pool() {
    let text = source("workspace/mod.rs");
    let helper = function(&text, "config_io").expect("workspace/mod.rs: no fn config_io");
    assert!(helper.contains("spawn_blocking("));
}
