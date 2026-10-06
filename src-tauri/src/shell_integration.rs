//! Shell integration setup for zsh and bash.
//!
//! Purpose: Materializes the per-shell integration rc that emits OSC 133
//! command-boundary marks + OSC 7 cwd, and returns what the frontend needs to
//! apply when spawning the shell: environment overrides **and** command-line
//! arguments. zsh and bash are supported; other shells return `None` and the
//! terminal spawns without integration (graceful degrade).
//!
//! Why the return type carries `args`: zsh is hooked purely through
//! the environment (`ZDOTDIR`), but bash has no environment hook that applies
//! to interactive shells — `BASH_ENV` is non-interactive-only — so it must be
//! spawned as `bash --rcfile <path>`. Rather than special-casing bash in the
//! frontend, the contract became `{ env, args }` for every shell; zsh returns
//! `args: []` and behaves byte-identically to before.
//!
//! Each script is embedded at compile time via `include_str!`, so there is no
//! runtime resource bundling. They are written to
//! `<appLocalData>/shell-integration/<shell>/<rc>`.
//!
//! Windows is deliberately untouched: `get_default_shell` yields `%COMSPEC%`
//! there, and a configured `bash.exe` does not match the `bash` basename, so
//! Windows keeps spawning with no integration exactly as before.
//!
//! Only a shell VMark discovered is prepared (`require_discovered_shell`): the
//! `shell` argument comes from the webview and, for zsh, is executed here, so
//! it must be one of the paths `shell_env` offers — not merely a file that
//! happens to be called `zsh`. Anything else is an error, and the terminal
//! spawns without integration.
//!
//! @coordinates-with shell_env.rs — the shells VMark discovered (the allowlist)
//! @coordinates-with lib.rs — command registered in generate_handler![]
//! @coordinates-with src/components/Terminal/terminalSpawnEnv.ts — applies env + args
//! @coordinates-with src/components/Terminal/spawnPty.ts — forwards args to spawn()
//! @module shell_integration

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Runtime};

/// Per-process counter for unique temp filenames (avoids concurrent-spawn races).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// zsh integration rc, embedded at compile time.
const ZSH_INTEGRATION: &str = include_str!("../resources/shell-integration/vmark.zsh");
/// bash integration rc, embedded at compile time.
const BASH_INTEGRATION: &str = include_str!("../resources/shell-integration/vmark.bash");

/// What the frontend must apply when spawning an integrated shell.
///
/// `env` is merged onto the base environment; `args` is passed to `spawn` in
/// place of the previously hardcoded empty argument list.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct ShellIntegration {
    pub env: BTreeMap<String, String>,
    pub args: Vec<String>,
}

/// The shells VMark knows how to instrument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    Zsh,
    Bash,
}

impl ShellKind {
    /// Subdirectory under `shell-integration/` holding this shell's rc.
    fn dir_name(self) -> &'static str {
        match self {
            ShellKind::Zsh => "zsh",
            ShellKind::Bash => "bash",
        }
    }

    /// Filename the rc is written as. zsh requires the literal `.zshrc`
    /// (it is found by name inside `ZDOTDIR`); bash is pointed at explicitly
    /// by `--rcfile`, so the name is ours to choose.
    fn rc_name(self) -> &'static str {
        match self {
            ShellKind::Zsh => ".zshrc",
            ShellKind::Bash => "vmark.bash",
        }
    }

    /// The embedded script for this shell.
    fn script(self) -> &'static str {
        match self {
            ShellKind::Zsh => ZSH_INTEGRATION,
            ShellKind::Bash => BASH_INTEGRATION,
        }
    }
}

/// Extract the executable basename from a shell path (`/bin/zsh` → `zsh`).
fn shell_basename(shell: &str) -> &str {
    std::path::Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
}

/// Classify a shell path. Returns `None` for anything VMark cannot instrument
/// — including `bash.exe`, which keeps Windows on the un-integrated path.
fn shell_kind(shell: &str) -> Option<ShellKind> {
    match shell_basename(shell) {
        "zsh" => Some(ShellKind::Zsh),
        "bash" => Some(ShellKind::Bash),
        // fish needs XDG_DATA_DIRS + vendor_conf.d, a different mechanism —
        // tracked as a follow-up, not a cheap rider on --rcfile.
        _ => None,
    }
}

/// Prepare shell integration for `shell`. Returns the env overrides and spawn
/// args to apply, or `None` for shells without integration support.
///
/// The body runs on a BLOCKING thread: it does synchronous filesystem work and,
/// on the first zsh launch, a login-shell probe that can take seconds
/// (`login_shell_zdotdir`). Doing that directly in an async command occupies a
/// runtime worker for the whole duration — during terminal startup, which is
/// exactly when other IPC needs to be responsive (audit).
#[tauri::command]
pub async fn prepare_shell_integration<R: Runtime>(
    shell: String,
    app: AppHandle<R>,
) -> Result<Option<ShellIntegration>, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_shell_integration_blocking(shell, app))
        .await
        .map_err(|e| format!("Shell-integration task failed: {e}"))?
}

/// The synchronous body of `prepare_shell_integration`.
fn prepare_shell_integration_blocking<R: Runtime>(
    shell: String,
    app: AppHandle<R>,
) -> Result<Option<ShellIntegration>, String> {
    prepare_with(&shell, discovered_shells, || {
        app.path().app_local_data_dir().map_err(|e| {
            log::warn!("[shell_integration] no app data dir; spawning without integration: {e}");
            format!("Failed to resolve app data dir: {e}")
        })
    })
}

/// The shells VMark itself found on this machine: the ones Settings offers
/// (`list_available_shells`) plus the default it falls back to
/// (`get_default_shell`, which can name a shell `/etc/shells` omits). These are
/// the only values the terminal ever passes as `shell`.
fn discovered_shells() -> Vec<String> {
    let mut shells = crate::shell_env::available_shells();
    let default = crate::shell_env::default_shell();
    if !shells.contains(&default) {
        shells.push(default);
    }
    shells
}

/// Refuse a `shell` VMark did not discover.
///
/// `shell` arrives from the webview, and for zsh this command RUNS it
/// (`<shell> -lic …`, the `ZDOTDIR` probe). Judging it by file name alone made
/// any file called `zsh` runnable from a script in the page. The comparison is
/// with the discovered path exactly as VMark spelled it: a different path to
/// the same file — through a symlink, `..`, a doubled or trailing slash — is
/// not one VMark found, and is refused without touching the filesystem.
fn require_discovered_shell(shell: &str, discovered: &[String]) -> Result<(), String> {
    if discovered.iter().any(|known| known == shell) {
        Ok(())
    } else {
        Err(format!(
            "shell {shell:?} is not one VMark found on this system"
        ))
    }
}

/// `prepare_shell_integration` with its two environment inputs injected: the
/// shells VMark discovered, and where the app keeps its local data. Both are
/// asked for only once `shell` is one VMark can instrument, so an unsupported
/// shell costs neither a shell lookup nor a directory.
fn prepare_with(
    shell: &str,
    discovered: impl FnOnce() -> Vec<String>,
    data_dir: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<Option<ShellIntegration>, String> {
    let Some(kind) = shell_kind(shell) else {
        return Ok(None);
    };
    require_discovered_shell(shell, &discovered()).inspect_err(|e| {
        log::warn!("[shell_integration] {e}; spawning without integration");
    })?;

    let base = data_dir()?;
    let dir = base.join("shell-integration").join(kind.dir_name());
    std::fs::create_dir_all(&dir).map_err(|e| {
        log::warn!("[shell_integration] cannot create {dir:?}; spawning without integration: {e}");
        format!("Failed to create integration dir: {e}")
    })?;
    write_rc_atomic(&dir, kind.rc_name(), kind.script()).map_err(|e| {
        log::warn!(
            "[shell_integration] cannot write {}; spawning without integration: {e}",
            kind.rc_name()
        );
        format!("Failed to install integration rc: {e}")
    })?;

    // Resolve via the SHELL being spawned, not the process $SHELL, which in a
    // minimal GUI env may be /bin/sh and misresolve (Codex audit). Only zsh
    // consumes this; bash carries no env override.
    let user_zdotdir = match kind {
        ShellKind::Zsh => crate::ai_provider::login_shell_zdotdir(shell),
        ShellKind::Bash => None,
    };
    Ok(Some(build_integration(kind, &dir, user_zdotdir)))
}

/// Build the `{ env, args }` pair for a prepared integration directory.
/// Pure — the filesystem work happens in the command above.
fn build_integration(
    kind: ShellKind,
    dir: &Path,
    user_zdotdir: Option<String>,
) -> ShellIntegration {
    match kind {
        ShellKind::Zsh => ShellIntegration {
            // `ZDOTDIR` points at the VMark integration dir so zsh reads our
            // rc; `USER_ZDOTDIR` carries the user's real ZDOTDIR (resolved
            // from a login shell — the GUI process env is minimal) so
            // `vmark.zsh` can source their config instead of falling back to
            // `$HOME` (terminal gap G1).
            env: build_zsh_env(dir, user_zdotdir),
            // zsh needs no args — this is what keeps zsh launches byte-identical
            // for existing users.
            args: Vec::new(),
        },
        ShellKind::Bash => ShellIntegration {
            env: BTreeMap::new(),
            args: vec![
                "--rcfile".to_string(),
                rc_path(dir, ShellKind::Bash).to_string_lossy().into_owned(),
            ],
        },
    }
}

/// Absolute path of a shell's materialized rc.
fn rc_path(dir: &Path, kind: ShellKind) -> PathBuf {
    dir.join(kind.rc_name())
}

/// Build the env overrides for the zsh integration. `USER_ZDOTDIR` is included
/// only when the user has a non-empty custom `ZDOTDIR`; when omitted,
/// `vmark.zsh`'s `${USER_ZDOTDIR:-$HOME}` fallback is correct.
fn build_zsh_env(integration_dir: &Path, user_zdotdir: Option<String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(
        "ZDOTDIR".to_string(),
        integration_dir.to_string_lossy().into_owned(),
    );
    if let Some(z) = user_zdotdir.filter(|s| !s.is_empty()) {
        env.insert("USER_ZDOTDIR".to_string(), z);
    }
    env
}

/// Atomically write `contents` to `<dir>/<file_name>`.
///
/// A concurrent spawn could otherwise source a half-written rc. We write a
/// per-call unique temp file then rename it into place (rename is atomic on
/// the same filesystem). The per-call unique name (PID + monotonic counter)
/// keeps two concurrent calls from clobbering each other's temp file before the
/// rename — the final rc is always one writer's complete contents, never
/// a torn mix.
///
/// Atomic, and deliberately NOT durable: nothing is synced. The rc is rewritten
/// from the embedded script before every shell spawn, so whatever a crash left
/// behind is replaced before it is next read, and a sync would add a full disk
/// flush to every terminal that opens.
fn write_rc_atomic(dir: &Path, file_name: &str, contents: &str) -> io::Result<()> {
    let rc = dir.join(file_name);
    let tmp = dir.join(format!(
        "{}.tmp.{}.{}",
        file_name,
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, &rc)?;
    Ok(())
}

#[cfg(test)]
#[path = "shell_integration.test.rs"]
mod tests;

#[cfg(test)]
#[path = "shell_integration_discovery.test.rs"]
mod discovery_tests;
