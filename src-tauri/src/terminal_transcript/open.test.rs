// WI-RA6.4 — a transcript that is not a regular file is refused without being
//   opened; one that is not there yet is "still waiting", not an error.

use super::*;
use std::io::Read;

#[test]
fn a_regular_file_is_opened_with_its_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("会话.jsonl");
    std::fs::write(&path, "一\n").unwrap();

    let (mut file, meta) = open_regular(&path).unwrap().expect("the file exists");

    assert_eq!(meta.len(), 4);
    let mut content = String::new();
    file.read_to_string(&mut content).unwrap();
    assert_eq!(
        content, "一\n",
        "non-blocking mode does not affect the read"
    );
}

#[test]
fn a_path_with_nothing_there_is_still_waiting() {
    let dir = tempfile::tempdir().unwrap();

    assert!(open_regular(&dir.path().join("t.jsonl")).unwrap().is_none());
}

#[test]
fn a_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    std::fs::create_dir(&path).unwrap();

    let error = open_regular(&path).expect_err("a directory is not a transcript");

    assert!(error.to_string().contains("regular file"), "{error}");
}

#[cfg(unix)]
mod special_files {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::time::Duration;

    fn make_fifo(path: &Path) {
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: `name` is a valid NUL-terminated path for the whole call.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
    }

    #[test]
    fn a_fifo_is_refused_without_ever_blocking_on_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        make_fifo(&path);

        // Opening a FIFO for reading blocks until a writer shows up, so the
        // call runs on its own thread and must answer within the deadline.
        let (done, answer) = std::sync::mpsc::channel();
        let target = path.clone();
        std::thread::spawn(move || {
            let _ = done.send(open_regular(&target).map(|opened| opened.is_some()));
        });
        let answer = answer.recv_timeout(Duration::from_secs(10));
        // Release a reader that did block, so a failing run leaves no thread.
        let _unblock = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path);

        let error = answer
            .expect("a FIFO must be refused, not opened")
            .expect_err("a FIFO is not a transcript");
        assert!(error.to_string().contains("regular file"), "{error}");
    }

    #[test]
    fn a_link_in_place_of_the_transcript_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("secret.jsonl");
        std::fs::write(&outside, b"secret\n").unwrap();
        let path = dir.path().join("t.jsonl");
        std::os::unix::fs::symlink(&outside, &path).unwrap();

        // The caller hands over a canonical path, so a link here was swapped
        // in after the path was confined.
        let error = open_regular(&path).expect_err("a link is not a transcript");

        assert!(error.to_string().contains("regular file"), "{error}");
    }

    #[test]
    fn the_open_itself_refuses_a_link_and_does_not_wait_on_a_fifo() {
        // What the descriptor-level guard is for: the path passed the first
        // check and was swapped afterwards. Reproduced by opening with the
        // same flags directly.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.jsonl");
        std::fs::write(&target, b"x\n").unwrap();
        let link = dir.path().join("link.jsonl");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let fifo = dir.path().join("fifo.jsonl");
        make_fifo(&fifo);
        let guarded = || {
            let mut options = OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
            options
        };

        assert!(guarded().open(&link).is_err(), "a link is not followed");
        let opened = guarded()
            .open(&fifo)
            .expect("opening a FIFO returns at once");
        assert!(!opened.metadata().unwrap().is_file());
    }
}
