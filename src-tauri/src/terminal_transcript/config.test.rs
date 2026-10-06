// WI-RA6.3 — enabling the transcript hook writes THROUGH a symlinked CLI
//   config (a dotfiles checkout keeps its link and gets the new content), a
//   link that leads nowhere fails loudly before anything is written, and the
//   replacement is a synced temp file renamed into place.

use super::super::configure;
use std::path::{Path, PathBuf};

struct Home {
    _dir: tempfile::TempDir,
    /// VMark's own binding directory.
    root: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
    /// Where a user keeps the real files their config links point at.
    dotfiles: PathBuf,
}

fn home() -> Home {
    let dir = tempfile::tempdir().expect("tempdir");
    // Canonical, so the macOS /var -> /private/var link is not part of the test.
    let base = dir.path().canonicalize().expect("canonical tempdir");
    let home = Home {
        root: base.join("bindings"),
        claude: base.join("claude 配置"),
        codex: base.join("codex"),
        dotfiles: base.join("dotfiles"),
        _dir: dir,
    };
    for created in [&home.claude, &home.codex, &home.dotfiles] {
        std::fs::create_dir_all(created).unwrap();
    }
    home
}

impl Home {
    fn settings(&self) -> PathBuf {
        self.claude.join("settings.json")
    }

    fn hooks(&self) -> PathBuf {
        self.codex.join("hooks.json")
    }

    fn enable(&self) -> Result<(), crate::command_error::CommandError> {
        configure(&self.root, true, &self.claude, &self.codex)
    }
}

fn has_hook(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .contains("terminal-transcript-hook.cjs")
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_plain_config_gets_the_hook_and_keeps_what_it_held() {
    let home = home();
    std::fs::write(home.settings(), br#"{"theme":"dark"}"#).unwrap();

    home.enable().unwrap();

    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(home.settings()).unwrap()).unwrap();
    assert_eq!(settings["theme"], "dark");
    assert!(has_hook(&home.settings()));
    assert!(has_hook(&home.hooks()), "a missing config is created");
}

#[test]
fn nothing_but_the_config_is_left_in_its_directory() {
    let home = home();
    std::fs::write(home.settings(), b"{}").unwrap();

    home.enable().unwrap();

    assert_eq!(entries(&home.claude), ["settings.json"]);
    assert_eq!(entries(&home.codex), ["hooks.json"]);
}

#[test]
fn a_config_directory_that_does_not_exist_yet_is_created() {
    let home = home();
    std::fs::remove_dir(&home.codex).unwrap();

    home.enable().unwrap();

    assert!(has_hook(&home.hooks()));
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn is_link(path: &Path) -> bool {
        std::fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_symlinked_config_stays_a_link_and_its_target_gets_the_hook() {
        let home = home();
        let real = home.dotfiles.join("claude-settings.json");
        std::fs::write(&real, br#"{"theme":"dark"}"#).unwrap();
        symlink(&real, home.settings()).unwrap();

        home.enable().unwrap();

        assert!(is_link(&home.settings()), "the link must survive");
        assert_eq!(std::fs::read_link(home.settings()).unwrap(), real);
        assert!(
            !is_link(&real),
            "the target is the regular file it always was"
        );
        assert!(has_hook(&real), "the content lands on the target");
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&real).unwrap()).unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(entries(&home.claude), ["settings.json"]);
        assert_eq!(entries(&home.dotfiles), ["claude-settings.json"]);
    }

    #[test]
    fn a_chain_of_links_with_a_relative_hop_is_followed_to_the_real_file() {
        let home = home();
        let real = home.dotfiles.join("real.json");
        std::fs::write(&real, b"{}").unwrap();
        // settings.json -> ../dotfiles/hop.json -> real.json (relative to its own directory)
        symlink("real.json", home.dotfiles.join("hop.json")).unwrap();
        symlink("../dotfiles/hop.json", home.settings()).unwrap();

        home.enable().unwrap();

        assert!(is_link(&home.settings()));
        assert!(is_link(&home.dotfiles.join("hop.json")));
        assert!(has_hook(&real));
    }

    #[test]
    fn a_link_to_a_missing_file_fails_loudly_and_writes_nothing() {
        let home = home();
        let missing = home.dotfiles.join("not-checked-out.json");
        symlink(&missing, home.settings()).unwrap();

        let error = home.enable().expect_err("a dangling link is an error");

        assert!(error.to_string().contains("settings.json"), "{error}");
        assert!(is_link(&home.settings()), "the link is left as it was");
        assert!(!missing.exists(), "the referent is not conjured up");
        assert!(
            !home.hooks().exists(),
            "neither config is written when one cannot be"
        );
        assert!(!home.root.join("enabled").exists());
    }

    #[test]
    fn a_link_loop_fails_loudly_and_writes_nothing() {
        let home = home();
        let other = home.claude.join("other.json");
        symlink(&other, home.settings()).unwrap();
        symlink(home.settings(), &other).unwrap();

        let error = home.enable().expect_err("a link loop is an error");

        assert!(error.to_string().contains("settings.json"), "{error}");
        assert!(is_link(&home.settings()));
        assert!(is_link(&other));
        assert!(!home.hooks().exists());
    }

    #[test]
    fn a_config_directory_that_is_a_link_is_written_through() {
        let home = home();
        let real_dir = home.dotfiles.join("claude");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::remove_dir(&home.claude).unwrap();
        symlink(&real_dir, &home.claude).unwrap();

        home.enable().unwrap();

        assert!(is_link(&home.claude));
        assert!(has_hook(&real_dir.join("settings.json")));
    }

    #[test]
    fn an_existing_config_keeps_its_mode_and_a_new_one_is_private() {
        let home = home();
        std::fs::write(home.settings(), b"{}").unwrap();
        std::fs::set_permissions(home.settings(), std::fs::Permissions::from_mode(0o644)).unwrap();

        home.enable().unwrap();

        assert_eq!(mode(&home.settings()), 0o644);
        assert_eq!(mode(&home.hooks()), 0o600);
    }

    #[test]
    fn a_linked_configs_target_keeps_its_mode() {
        let home = home();
        let real = home.dotfiles.join("settings.json");
        std::fs::write(&real, b"{}").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&real, home.settings()).unwrap();

        home.enable().unwrap();

        assert_eq!(mode(&real), 0o640);
    }

    #[test]
    fn a_config_that_cannot_be_replaced_is_left_intact_with_no_debris() {
        // SAFETY: `geteuid` takes no arguments and cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            return; // Directory modes do not bind root.
        }
        let home = home();
        std::fs::write(home.settings(), br#"{"theme":"dark"}"#).unwrap();
        std::fs::set_permissions(&home.claude, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = home.enable();

        std::fs::set_permissions(&home.claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            result.is_err(),
            "a read-only directory cannot take a rename"
        );
        assert_eq!(
            std::fs::read(home.settings()).unwrap(),
            br#"{"theme":"dark"}"#
        );
        assert_eq!(entries(&home.claude), ["settings.json"]);
    }
}
