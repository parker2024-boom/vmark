//! Prompt delivery to a CLI provider's stdin.
//!
//! Purpose: hand the prompt to the child on its stdin, from a task of its own,
//! and report whether the child took all of it.
//!
//! Key decisions:
//!   - The prompt is text the app did not write (document content), so it is
//!     never an argument. An argument to a Windows `.cmd` shim is parsed by
//!     cmd.exe, a line break in one is refused at spawn, and an argument list
//!     has a size limit a document can exceed. stdin has none of the three.
//!   - Written from its own task. A child may answer while it is still
//!     reading; a write that waits for the whole prompt to be taken before
//!     stdout is first read deadlocks once both pipes are full, and it would
//!     hold a cancel back for as long as the child does not read.
//!   - The pipe is closed after the last byte, so the child sees end-of-input.
//!   - Aborted when dropped: a cancelled or timed-out run must not leave a
//!     task holding the prompt for a reader that will never come.
//!
//! @coordinates-with ai_provider/cli.rs — the only caller
//! @module ai_provider/cli/prompt

use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::task::JoinHandle;

/// The task writing one prompt to one child's stdin.
pub(super) struct PromptWriter(JoinHandle<std::io::Result<()>>);

impl PromptWriter {
    /// Start writing `prompt` to `stdin`. A child spawned without a stdin pipe
    /// cannot be given a prompt at all, which is an error here rather than a
    /// run that silently answers nothing.
    pub(super) fn start(stdin: Option<ChildStdin>, prompt: &str) -> Result<Self, String> {
        let mut stdin = stdin.ok_or_else(|| "Child stdin pipe missing".to_string())?;
        let prompt = prompt.to_owned();
        Ok(Self(tokio::spawn(async move {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await
        })))
    }

    /// Wait for the write to end. `Err` means the child stopped reading before
    /// the whole prompt was written.
    pub(super) async fn finish(mut self) -> std::io::Result<()> {
        match (&mut self.0).await {
            Ok(written) => written,
            Err(join_error) => Err(std::io::Error::other(join_error)),
        }
    }
}

impl Drop for PromptWriter {
    fn drop(&mut self) {
        self.0.abort();
    }
}
