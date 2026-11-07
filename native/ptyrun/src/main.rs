//! ptyrun — run exactly one program on a freshly allocated pseudo-terminal
//! and copy everything it writes to the terminal to our own stdout.
//!
//! Usage: ptyrun [--cols N] [--rows N] -- /absolute/program [args...]
//!
//! Why this exists: some CLIs only draw progress bars when they believe they
//! are talking to a terminal. The webOS JS service cannot allocate a PTY from
//! Node.js without a native addon, so it launches this tiny static helper
//! instead (same approach as webOS Terminal's `ptybridge`).
//!
//! Behaviour that the service relies on:
//! * The child gets its own session with the PTY as controlling terminal.
//! * The child's stdin is /dev/null, so it behaves non-interactively and
//!   prompts (e.g. the licence prompt) can never block a run. Only stdout and
//!   stderr are the terminal. Licence prompts must be answered over SSH.
//! * SIGTERM/SIGINT/SIGHUP/SIGQUIT sent to ptyrun are forwarded to the
//!   child's whole process group.
//! * If ptyrun dies (or its parent dies), the child is killed
//!   (PR_SET_PDEATHSIG), so a cancelled test never leaves a stray process.
//! * Exit status mirrors the child: its exit code, or 128+signal.
//!   126/127 mean the program could not be executed; the reason is printed
//!   on ptyrun's real stderr as "ptyrun: exec failed: <errno text>".

use std::ffi::{CStr, CString};
use std::io::{self, Write};
use std::process::exit;
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};

static CHILD_PID: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward_signal(sig: libc::c_int) {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        // The child called setsid(), so its pid is also its process group.
        unsafe {
            libc::kill(-pid, sig);
        }
    }
}

fn die(msg: &str, code: i32) -> ! {
    let _ = writeln!(io::stderr(), "ptyrun: {}", msg);
    exit(code);
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn strerror(e: i32) -> String {
    unsafe { CStr::from_ptr(libc::strerror(e)).to_string_lossy().into_owned() }
}

struct Options {
    cols: u16,
    rows: u16,
    argv: Vec<CString>,
}

fn parse_args() -> Options {
    let mut cols: u16 = 100;
    let mut rows: u16 = 30;
    let mut args = std::env::args().skip(1);
    let mut argv = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--cols" | "--rows" => {
                let v = args
                    .next()
                    .and_then(|s| s.parse::<u16>().ok())
                    .filter(|v| *v >= 10 && *v <= 1000)
                    .unwrap_or_else(|| die(&format!("{} needs a number 10..1000", a), 2));
                if a == "--cols" {
                    cols = v
                } else {
                    rows = v
                }
            }
            "--" => {
                for rest in args.by_ref() {
                    argv.push(CString::new(rest).unwrap_or_else(|_| die("NUL in argument", 2)));
                }
            }
            _ => die(&format!("unknown option {:?}; usage: ptyrun [--cols N] [--rows N] -- PROGRAM [ARGS...]", a), 2),
        }
    }
    if argv.is_empty() {
        die("usage: ptyrun [--cols N] [--rows N] -- PROGRAM [ARGS...]", 2);
    }
    if !argv[0].as_bytes().starts_with(b"/") {
        die("PROGRAM must be an absolute path", 2);
    }
    Options { cols, rows, argv }
}

fn write_all_fd(fd: i32, mut data: &[u8]) -> bool {
    while !data.is_empty() {
        let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if n < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return false;
        }
        data = &data[n as usize..];
    }
    true
}

fn status_to_code(status: i32) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

fn main() {
    let opts = parse_args();

    unsafe {
        // Die with our parent (the Node service) so nothing outlives it.
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0);
        if libc::getppid() == 1 {
            exit(1);
        }
        // We want EPIPE from write() rather than being killed silently.
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ws = libc::winsize { ws_row: opts.rows, ws_col: opts.cols, ws_xpixel: 0, ws_ypixel: 0 };
    let rc = unsafe { libc::openpty(&mut master, &mut slave, ptr::null_mut(), ptr::null(), &ws) };
    if rc != 0 {
        die(&format!("cannot allocate a pseudo-terminal: {} (is the service elevated to root?)", strerror(errno())), 125);
    }

    // No local echo: nothing is ever typed into this terminal.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(slave, &mut t) == 0 {
            t.c_lflag &= !(libc::ECHO | libc::ECHOE | libc::ECHOK | libc::ECHONL | libc::ECHOCTL);
            libc::tcsetattr(slave, libc::TCSANOW, &t);
        }
    }

    let devnull = unsafe { libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_RDONLY | libc::O_CLOEXEC) };
    if devnull < 0 {
        die(&format!("cannot open /dev/null: {}", strerror(errno())), 125);
    }

    // Close-on-exec pipe: the child reports a failed execv() through it.
    let mut errpipe = [-1i32; 2];
    if unsafe { libc::pipe2(errpipe.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        die(&format!("pipe2: {}", strerror(errno())), 125);
    }

    let mut argv_ptrs: Vec<*const libc::c_char> = opts.argv.iter().map(|a| a.as_ptr()).collect();
    argv_ptrs.push(ptr::null());

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        die(&format!("fork: {}", strerror(errno())), 125);
    }

    if pid == 0 {
        // ---- child: only async-signal-safe calls from here on ----
        unsafe {
            libc::close(master);
            libc::close(errpipe[0]);
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
            libc::dup2(devnull, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            if slave > 2 {
                libc::close(slave);
            }
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0);
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            libc::execv(argv_ptrs[0], argv_ptrs.as_ptr());
            let e: i32 = *libc::__errno_location();
            libc::write(errpipe[1], &e as *const i32 as *const libc::c_void, 4);
            libc::_exit(if e == libc::ENOENT { 127 } else { 126 });
        }
    }

    // ---- parent ----
    CHILD_PID.store(pid, Ordering::SeqCst);
    unsafe {
        libc::close(slave);
        libc::close(devnull);
        libc::close(errpipe[1]);
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = forward_signal as extern "C" fn(libc::c_int) as usize;
        sa.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut sa.sa_mask);
        for s in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT] {
            libc::sigaction(s, &sa, ptr::null_mut());
        }
    }

    // Did execv succeed? (read returns 0 when the CLOEXEC pipe closes.)
    let mut e: i32 = 0;
    let n = loop {
        let n = unsafe { libc::read(errpipe[0], &mut e as *mut i32 as *mut libc::c_void, 4) };
        if n < 0 && errno() == libc::EINTR {
            continue;
        }
        break n;
    };
    unsafe { libc::close(errpipe[0]) };
    if n == 4 {
        let mut st = 0;
        unsafe { libc::waitpid(pid, &mut st, 0) };
        let _ = writeln!(io::stderr(), "ptyrun: exec failed: {} ({})", strerror(e), opts.argv[0].to_string_lossy());
        exit(if e == libc::ENOENT { 127 } else { 126 });
    }

    let mut buf = [0u8; 8192];
    let mut status: i32 = 0;
    let mut reaped = false;
    loop {
        let mut pfd = libc::pollfd { fd: master, events: libc::POLLIN, revents: 0 };
        let pr = unsafe { libc::poll(&mut pfd, 1, 250) };
        if pr < 0 && errno() != libc::EINTR {
            break;
        }
        if pr > 0 {
            let n = unsafe { libc::read(master, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n > 0 {
                if !write_all_fd(1, &buf[..n as usize]) {
                    // Our reader went away: stop the test.
                    forward_signal(libc::SIGTERM);
                    break;
                }
                continue;
            }
            if n == 0 || (n < 0 && errno() != libc::EINTR && errno() != libc::EAGAIN) {
                // EIO: every slave fd is closed, i.e. the program is gone.
                break;
            }
        }
        if !reaped {
            let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if r == pid {
                reaped = true;
                // Drain whatever is still buffered, then finish.
                unsafe {
                    let fl = libc::fcntl(master, libc::F_GETFL);
                    libc::fcntl(master, libc::F_SETFL, fl | libc::O_NONBLOCK);
                }
                loop {
                    let n = unsafe { libc::read(master, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
                    if n <= 0 || !write_all_fd(1, &buf[..n as usize]) {
                        break;
                    }
                }
                break;
            }
        }
    }

    if !reaped {
        loop {
            let r = unsafe { libc::waitpid(pid, &mut status, 0) };
            if r == pid || (r < 0 && errno() != libc::EINTR) {
                break;
            }
        }
    }
    exit(status_to_code(status));
}
