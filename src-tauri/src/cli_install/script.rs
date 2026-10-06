//! The privileged shell commands for the `vmark` launcher, as text.
//!
//! Purpose: build the `/bin/sh` commands `run_admin_shell` hands to the
//! administrator shell. They are kept apart from the `osascript` call so that
//! everything about them — above all the quoting — is tested by running them
//! unprivileged against a temp directory.
//!
//! Key decisions:
//!   - ROOT READS NOTHING THE USER CAN WRITE. The launcher's content travels
//!     inside the command as a single-quoted literal and the privileged shell
//!     writes it. It used to be written unprivileged under `$TMPDIR` and moved
//!     into place by root after the password dialog, which has no time limit:
//!     any process of the same user could swap that temp entry while the
//!     dialog was up, and root then installed the swap — and `chmod`ed
//!     whatever a planted link pointed at.
//!   - The target is CREATED, never overwritten and never followed. The
//!     command refuses an entry that is already there (a file, or a link of
//!     any kind), creates the file under `set -C` so the redirect cannot
//!     clobber one that appears in between, and sets the mode with
//!     `chmod -h`, which acts on the entry itself rather than a link's target.
//!   - VERIFIED IN THE SAME SHELL. The file is compared with the literal it
//!     was written from; on a mismatch it is removed and the command fails, so
//!     nothing unverified stays installed.
//!   - Each refusal has its own exit status, which `osascript` reports back
//!     and `mod.rs` turns into the matching error.
//!
//! Residual: when the install directory is writable by the user (a Homebrew
//! layout on Intel Macs), every entry in it is the user's to replace at any
//! moment, before and after the install. The steps above narrow what a planted
//! entry can make root do to a race with a single shell command; no sequence
//! of path-based steps makes such a directory trustworthy.
//!
//! @coordinates-with cli_install/mod.rs — runs these through `run_admin_shell`
//! @module cli_install/script

/// Exit status of [`install_command`] when something already occupies the
/// target path. It is left untouched.
pub(super) const EXIT_TARGET_EXISTS: i32 = 3;

/// Exit status of [`install_command`] when the installed file did not match
/// the content it was written from. It has been removed.
pub(super) const EXIT_MISMATCH: i32 = 4;

/// POSIX-safe single-quote wrap. Escapes embedded single quotes via the
/// `'\''` close-escape-open idiom, then wraps in single quotes. Inside single
/// quotes `/bin/sh` gives no character a meaning except `'` itself, so the
/// result is one word holding exactly `s` — whatever `s` contains.
///
/// Load-bearing: everything interpolated into the privileged command goes
/// through this, the launcher's whole content included.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The command that installs `content` as an executable file at `target`,
/// creating `parent` first if needed.
///
/// Exit status: 0 installed and verified; [`EXIT_TARGET_EXISTS`];
/// [`EXIT_MISMATCH`]; anything else is a step that failed on its own
/// (`mkdir`, the write).
pub(super) fn install_command(content: &str, parent: &str, target: &str) -> String {
    install_script(content, content, parent, target)
}

/// [`install_command`] with the literal that is written and the literal the
/// result is verified against given separately. They are always the same
/// content; the split exists so a test can make them differ and see the
/// mismatch branch remove the file.
fn install_script(written: &str, expected: &str, parent: &str, target: &str) -> String {
    let written = shell_single_quote(written);
    let expected = shell_single_quote(expected);
    let parent = shell_single_quote(parent);
    let target = shell_single_quote(target);
    format!(
        "umask 022; \
         mkdir -p {parent} || exit 1; \
         if [ -e {target} ] || [ -L {target} ]; then exit {EXIT_TARGET_EXISTS}; fi; \
         (set -C; printf '%s' {written} > {target}) || exit 1; \
         if chmod -h 755 {target} && printf '%s' {expected} | cmp -s - {target}; \
         then exit 0; fi; \
         rm -f {target}; \
         exit {EXIT_MISMATCH}"
    )
}

/// The command that removes the launcher at `target`.
pub(super) fn uninstall_command(target: &str) -> String {
    format!("rm {}", shell_single_quote(target))
}

/// The AppleScript that runs `shell_cmd` through `/bin/sh`, as the
/// administrator when `privileged`. The escaping here is for AppleScript's
/// string syntax only (`\` and `"`); it is not what keeps `shell_cmd` safe —
/// [`shell_single_quote`] is.
pub(super) fn apple_script(shell_cmd: &str, privileged: bool) -> String {
    let literal = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    if privileged {
        format!("do shell script \"{literal}\" with administrator privileges")
    } else {
        format!("do shell script \"{literal}\"")
    }
}

/// The exit status `osascript` reports for a failed `do shell script`: the
/// number in the trailing parentheses of its error line
/// (`… execution error: The command exited with a non-zero status. (3)`).
pub(super) fn shell_exit_status(osascript_stderr: &str) -> Option<i32> {
    let line = osascript_stderr.trim_end();
    let open = line.rfind('(')?;
    line[open + 1..].strip_suffix(')')?.parse().ok()
}

#[cfg(test)]
#[path = "script.test.rs"]
mod tests;
