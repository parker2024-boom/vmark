//! Program names the editor-override guard judges by.
//!
//! Purpose: the two lists `override_guard.rs` consults — the editors VMark
//! accepts by bare name, and the programs that run the file they are given.
//! Data only; the rules that apply them are in the guard.
//!
//! Both lists are lowercase. `RUNS_ITS_ARGUMENT` is a list of known
//! offenders — a floor, not a proof that anything absent from it is an
//! editor.
//!
//! @coordinates-with external_editor/override_guard.rs — the only reader
//! @module external_editor/program_names

/// Editors VMark accepts by bare name (resolved on the login-shell PATH).
/// Anything else must be given as a full path.
pub(super) const KNOWN_EDITORS: &[&str] = &[
    // VS Code family and other GUI editors
    "code",
    "code-insiders",
    "codium",
    "vscodium",
    "cursor",
    "windsurf",
    "zed",
    "zeditor",
    "subl",
    "sublime_text",
    "atom",
    "mate",
    "bbedit",
    "nova",
    "xed",
    "lapce",
    "lite-xl",
    "fleet",
    "kate",
    "kwrite",
    "gedit",
    "gnome-text-editor",
    "mousepad",
    "pluma",
    "geany",
    "notepad",
    "notepad++",
    // JetBrains launchers
    "idea",
    "webstorm",
    "pycharm",
    "phpstorm",
    "goland",
    "clion",
    "rustrover",
    "rubymine",
    "rider",
    // Vim, Emacs and other terminal-born editors
    "nvim",
    "vim",
    "vi",
    "gvim",
    "mvim",
    "neovide",
    "vimr",
    "emacs",
    "emacsclient",
    "nano",
    "micro",
    "hx",
    "helix",
    "kak",
];

/// File names (lowercase, without a Windows/bundle suffix or a version tail)
/// of programs that run the file they are given instead of opening it: shells,
/// interpreters for the code files VMark opens, generic launchers, and
/// terminal emulators (`open -a Terminal.app script.sh` runs the script).
pub(super) const RUNS_ITS_ARGUMENT: &[&str] = &[
    // shells
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "mksh",
    "csh",
    "tcsh",
    "ash",
    "busybox",
    "nu",
    "elvish",
    "xonsh",
    "pwsh",
    "powershell",
    "cmd",
    // interpreters and script runners
    "python",
    "pythonw",
    "pypy",
    "ipython",
    "ruby",
    "jruby",
    "irb",
    "node",
    "nodejs",
    "deno",
    "bun",
    "tsx",
    "ts-node",
    "jsc",
    "d8",
    "qjs",
    "perl",
    "php",
    "lua",
    "luajit",
    "luau",
    "tclsh",
    "wish",
    "osascript",
    "rust-script",
    "java",
    "wscript",
    "cscript",
    "mshta",
    // launchers that execute or dispatch their argument
    "env",
    "xargs",
    "nohup",
    "sudo",
    "doas",
    "nice",
    "time",
    "open",
    "xdg-open",
    "start",
    "explorer",
    "rundll32",
    // terminal emulators
    "terminal",
    "iterm",
    "iterm2",
    "warp",
    "kitty",
    "alacritty",
    "wezterm",
    "ghostty",
    "hyper",
    "python launcher",
];
