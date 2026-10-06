// WI-RA6.1 — the reader's source is interruptible: a read blocked on a
//   terminal that some process still holds open returns as soon as the session
//   asks, and output and end-of-output are still reported as before.

use super::*;
use portable_pty::{native_pty_system, PtyPair, PtySize};
use std::fs::File;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::mpsc;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(10);

fn open_pty() -> PtyPair {
    native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty")
}

/// A second handle on the slave side, the way a process started in the
/// terminal holds it.
fn open_slave(pair: &PtyPair) -> File {
    let name = pair.master.tty_name().expect("slave tty name");
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY)
        .open(name)
        .expect("open slave")
}

/// Run one `read` on its own thread and return what it produced, failing the
/// test rather than hanging it when the read never returns.
fn read_on_a_thread(mut source: OutputSource) -> (io::Result<Chunk>, Vec<u8>, OutputSource) {
    let (done, result) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 256];
        let chunk = source.read(&mut buf);
        let _ = done.send((chunk, buf, source));
    });
    result
        .recv_timeout(DEADLINE)
        .expect("the read must return within the deadline")
}

#[test]
fn read_returns_what_the_slave_wrote() {
    let pair = open_pty();
    let (source, _interrupter) = channel(pair.master.as_ref()).expect("channel");
    let mut slave = open_slave(&pair);
    slave.write_all("héllo 你好\n".as_bytes()).unwrap();

    let (chunk, buf, _source) = read_on_a_thread(source);

    let Ok(Chunk::Data(n)) = chunk else {
        panic!("expected data");
    };
    // The terminal's output processing turns the newline into CR LF.
    assert_eq!(&buf[..n], "héllo 你好\r\n".as_bytes());
}

#[test]
fn read_reports_the_end_when_every_slave_handle_is_closed() {
    let pair = open_pty();
    let (source, _interrupter) = channel(pair.master.as_ref()).expect("channel");
    let PtyPair { slave, master } = pair;
    drop(slave);

    let (chunk, _, _source) = read_on_a_thread(source);

    assert!(matches!(chunk, Ok(Chunk::Eof)));
    drop(master);
}

#[test]
fn interrupt_ends_a_read_blocked_on_a_terminal_that_is_still_held_open() {
    let pair = open_pty();
    let (source, interrupter) = channel(pair.master.as_ref()).expect("channel");
    // Held for the whole test: without the interrupt this read never returns.
    let _orphan = open_slave(&pair);

    let (done, result) = mpsc::channel();
    std::thread::spawn(move || {
        let mut source = source;
        let chunk = source.read(&mut [0u8; 16]);
        let _ = done.send(chunk);
    });
    assert!(
        result.recv_timeout(Duration::from_millis(50)).is_err(),
        "nothing to read yet, so the read is still waiting"
    );

    interrupter.interrupt();

    let chunk = result
        .recv_timeout(DEADLINE)
        .expect("the interrupt must end the read");
    assert!(matches!(chunk, Ok(Chunk::Interrupted)));
}

#[test]
fn an_interrupt_wins_over_pending_output_and_stays_in_force() {
    let pair = open_pty();
    let (mut source, interrupter) = channel(pair.master.as_ref()).expect("channel");
    let mut slave = open_slave(&pair);
    slave.write_all(b"pending\n").unwrap();

    interrupter.interrupt();
    interrupter.interrupt();

    let mut buf = [0u8; 64];
    for _ in 0..3 {
        assert!(matches!(source.read(&mut buf), Ok(Chunk::Interrupted)));
    }
    assert!(source
        .interrupted_within(Duration::from_secs(5))
        .expect("wait"));
}

#[test]
fn a_bounded_wait_times_out_when_nobody_interrupts() {
    let pair = open_pty();
    let (source, _interrupter) = channel(pair.master.as_ref()).expect("channel");

    let interrupted = source
        .interrupted_within(Duration::from_millis(20))
        .expect("wait");

    assert!(!interrupted);
}

#[test]
fn interrupting_after_the_reader_is_gone_is_harmless() {
    let pair = open_pty();
    let (source, interrupter) = channel(pair.master.as_ref()).expect("channel");
    drop(source);

    interrupter.interrupt();
    interrupter.interrupt();
}

#[test]
fn the_writer_still_blocks_rather_than_failing() {
    // The reader must not switch the shared open file description to
    // non-blocking mode: a paste larger than the terminal's input queue
    // relies on the write waiting for the foreground process.
    let pair = open_pty();
    let (_source, _interrupter) = channel(pair.master.as_ref()).expect("channel");
    let raw = pair.master.as_raw_fd().expect("master descriptor");

    // SAFETY: `raw` is the open master descriptor `pair` owns.
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };

    assert!(flags >= 0, "F_GETFL failed");
    assert_eq!(flags & libc::O_NONBLOCK, 0, "the master must stay blocking");
}

/// The source used where the master offers no interruptible wait (Windows).
/// It is plain Rust over a `Read`, so its behaviour is pinned here.
mod without_a_multiplexer {
    use super::super::fallback::from_reader;
    use super::{Chunk, DEADLINE};
    use std::io::{Cursor, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn output_and_its_end_are_reported() {
        let (mut source, _interrupter) =
            from_reader(Box::new(Cursor::new("héllo".as_bytes().to_vec())));
        let mut buf = [0u8; 64];

        let Ok(Chunk::Data(n)) = source.read(&mut buf) else {
            panic!("expected data");
        };
        assert_eq!(&buf[..n], "héllo".as_bytes());
        assert!(matches!(source.read(&mut buf), Ok(Chunk::Eof)));
    }

    #[test]
    fn an_interrupt_is_honoured_before_a_read_and_stays_in_force() {
        let (mut source, interrupter) = from_reader(Box::new(Cursor::new(b"pending".to_vec())));

        interrupter.interrupt();
        interrupter.interrupt();

        let mut buf = [0u8; 64];
        for _ in 0..3 {
            assert!(matches!(source.read(&mut buf), Ok(Chunk::Interrupted)));
        }
    }

    #[test]
    fn an_interrupt_that_arrives_during_a_blocked_read_wins_over_its_result() {
        let (blocked, mut peer) = UnixStream::pair().unwrap();
        let (mut source, interrupter) = from_reader(Box::new(blocked));
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(source.read(&mut [0u8; 16]));
        });
        assert!(
            result.recv_timeout(Duration::from_millis(50)).is_err(),
            "nothing to read yet, so the read is still waiting"
        );

        interrupter.interrupt();
        // The read itself cannot be woken here; it returns when data arrives.
        peer.write_all(b"late").unwrap();

        let chunk = result.recv_timeout(DEADLINE).expect("the read returns");
        assert!(matches!(chunk, Ok(Chunk::Interrupted)));
    }

    #[test]
    fn a_bounded_wait_times_out_or_ends_early_on_an_interrupt() {
        let (source, interrupter) = from_reader(Box::new(Cursor::new(Vec::new())));
        assert!(!source
            .interrupted_within(Duration::from_millis(20))
            .unwrap());

        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(source.interrupted_within(Duration::from_secs(600)));
        });
        interrupter.interrupt();

        let interrupted = result
            .recv_timeout(DEADLINE)
            .expect("the interrupt must cut the wait short");
        assert!(matches!(interrupted, Ok(true)));
    }
}

/// WI-RA7C.6 — on the fallback (ConPTY) a bounded read is the plain read: the
/// pipe cannot be waited on with a bound, so it never reports idle.
#[test]
fn a_bounded_read_on_the_fallback_is_the_plain_read() {
    let (mut source, _interrupter) =
        super::fallback::from_reader(Box::new(std::io::Cursor::new(b"abc".to_vec())));
    let mut buf = [0u8; 8];
    assert!(matches!(
        source.read_within(&mut buf, Duration::from_millis(1)),
        Ok(Some(Chunk::Data(3)))
    ));
    assert!(matches!(
        source.read_within(&mut buf, Duration::from_millis(1)),
        Ok(Some(Chunk::Eof))
    ));
}

/// WI-RA7C.6 — a bounded read on a real pty returns `None` once the terminal
/// has been quiet that long, and still returns output that is waiting.
#[test]
fn a_bounded_read_reports_a_quiet_terminal_and_still_returns_output() {
    let pair = open_pty();
    let (mut source, _interrupter) = channel(pair.master.as_ref()).expect("channel");
    let mut slave = open_slave(&pair);
    let mut buf = [0u8; 64];

    assert!(matches!(
        source.read_within(&mut buf, Duration::from_millis(20)),
        Ok(None)
    ));

    slave.write_all(b"now\n").unwrap();
    let Ok(Some(Chunk::Data(n))) = source.read_within(&mut buf, DEADLINE) else {
        panic!("expected the pending output");
    };
    assert!(String::from_utf8_lossy(&buf[..n]).contains("now"));
}
