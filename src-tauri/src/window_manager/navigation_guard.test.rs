// WI-RA8.1 — the navigation allow/deny decision for app webviews.
// WI-RA25.1 — the video embeds the CSP frames load in release builds too.

use std::sync::LazyLock;

use super::*;

const DEV_URL: &str = "http://localhost:1420/";

fn url(s: &str) -> Url {
    Url::parse(s).unwrap_or_else(|e| panic!("test URL {s:?} does not parse: {e}"))
}

/// The outside origins the shipped CSP frames, read as the plugin reads them.
static FRAMED: LazyLock<Vec<Origin>> = LazyLock::new(|| framed_origins(&app_csp()));

/// A release build where custom protocols are schemes (macOS, Linux).
fn release() -> AppOrigins<'static> {
    AppOrigins {
        dev_url: None,
        http_custom_protocols: false,
        framed: FRAMED.as_slice(),
    }
}

/// A release build where custom protocols ride on http (Windows, Android).
fn release_http() -> AppOrigins<'static> {
    AppOrigins {
        dev_url: None,
        http_custom_protocols: true,
        framed: FRAMED.as_slice(),
    }
}

fn assert_table(origins: AppOrigins<'_>, allowed: &[&str], denied: &[&str]) {
    for candidate in allowed {
        assert!(
            navigation_allowed(&url(candidate), origins),
            "{candidate} must be allowed under {origins:?}"
        );
    }
    for candidate in denied {
        assert!(
            !navigation_allowed(&url(candidate), origins),
            "{candidate} must be denied under {origins:?}"
        );
    }
}

#[test]
fn a_release_build_allows_only_its_own_pages() {
    assert_table(
        release(),
        &[
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "tauri://localhost/?file=%2FUsers%2Fa%2Fnote.md#heading",
            "tauri://localhost/pdf-export?htmlPath=%2Ftmp%2Fx.html",
            "tauri://localhost/settings",
            // The scheme is case-insensitive and arrives lowercased.
            "TAURI://localhost/",
            // Frames the app itself creates: the trusted HTML preview, and a
            // `srcdoc` frame (the sandboxed HTML preview, a terminal diagram).
            "vmark-trusted://doc/0123abcd?run=2",
            "about:srcdoc",
            "about:blank",
            // The video embeds: the frames the editor builds for YouTube
            // (privacy-enhanced host), Vimeo and Bilibili.
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://player.vimeo.com/video/76979871?h=a1b2c3d4e5",
            "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD",
        ],
        &[
            "https://evil.example/",
            "http://evil.example/login",
            "HTTPS://EVIL.EXAMPLE/",
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "vbscript:msgbox(1)",
            "data:text/html,<h1>phish</h1>",
            "DATA:text/html;base64,PGgxPng8L2gxPg==",
            "file:///etc/passwd",
            "FILE:///Users/a/evil.html",
            "blob:tauri://localhost/5a1c9d3e",
            "filesystem:tauri://localhost/temporary/x",
            "mailto:a@example.com",
            "tel:+15550100",
            "ftp://example.com/x",
            "ws://example.com/socket",
            // The asset protocol serves any granted local file. Nothing
            // navigates to it — images and media are subresources — and an
            // HTML file beside a hostile document would otherwise open in
            // the app's own window.
            "asset://localhost/%2FUsers%2Fa%2Frepo%2Fevil.html",
            // Right scheme, wrong host.
            "tauri://evil.example/",
            "tauri://localhost.evil.example/",
            "tauri://localhost:8080/",
            "tauri://user:pw@localhost/",
            "tauri://localhost@evil.example/",
            // Another platform's form of the app origin.
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://vmark-trusted.localhost/0123abcd",
            // What a dev build would allow.
            "http://localhost:1420/",
            "http://127.0.0.1:4321/__auth?t=nonce",
            // `about:` is not a wildcard.
            "about:config",
            "about:blank?x=1",
            "about:srcdoc?x=1",
        ],
    );
}

/// Only the exact origins the embeds are built on: not the provider's other
/// hosts, not plain http, not another port, not a lookalike.
#[test]
fn a_release_build_frames_the_embed_origins_and_nothing_near_them() {
    let embeds = [
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://WWW.YOUTUBE-NOCOOKIE.COM/embed/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com:443/embed/dQw4w9WgXcQ",
        "https://player.vimeo.com/video/76979871",
        "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD",
    ];
    let near_misses = [
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "https://youtube.com/embed/dQw4w9WgXcQ",
        "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com:8443/embed/dQw4w9WgXcQ",
        "https://user:pw@www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com.evil.example/embed/x",
        "https://evil.example/https://www.youtube-nocookie.com/embed/x",
        "https://vimeo.com/76979871",
        "https://www.player.vimeo.com/video/76979871",
        "https://bilibili.com/video/BV1xx411c7mD",
        "https://www.player.bilibili.com/player.html?bvid=BV1xx411c7mD",
        "wss://www.youtube-nocookie.com/",
    ];
    for origins in [release(), release_http()] {
        assert_table(origins, &embeds, &near_misses);
    }
}

#[test]
fn a_scheme_relative_link_resolves_to_another_host_and_is_denied() {
    // `<a href="//evil.example/x">` on an app page: the URL the webview
    // navigates to keeps the app's scheme and takes the link's host.
    let resolved = url("tauri://localhost/index.html")
        .join("//evil.example/x")
        .expect("joins");
    assert_eq!(resolved.as_str(), "tauri://evil.example/x");
    assert!(!navigation_allowed(&resolved, release()));

    let resolved = url("http://tauri.localhost/index.html")
        .join("//evil.example/x")
        .expect("joins");
    assert_eq!(resolved.as_str(), "http://evil.example/x");
    assert!(!navigation_allowed(&resolved, release_http()));
}

#[test]
fn a_release_build_on_an_http_protocol_platform_allows_only_its_own_pages() {
    assert_table(
        release_http(),
        &[
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html?file=C%3A%5Ca.md",
            "https://tauri.localhost/",
            "HTTP://TAURI.LOCALHOST/",
            "http://vmark-trusted.localhost/0123abcd?run=1",
            "about:srcdoc",
            "about:blank",
        ],
        &[
            "tauri://localhost/",
            "vmark-trusted://doc/0123abcd",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "http://evil.example/tauri.localhost",
            "http://user:pw@tauri.localhost/",
            "http://asset.localhost/C%3A%5CUsers%5Ca%5Cevil.html",
            "https://asset.localhost/C%3A%5CUsers%5Ca%5Cevil.html",
            "https://vmark-trusted.localhost/0123abcd",
            "http://vmark-trusted.localhost:8080/0123abcd",
            "https://evil.example/",
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///C:/Users/a/evil.html",
            "http://localhost:1420/",
        ],
    );
}

#[test]
fn a_dev_build_allows_the_dev_server_and_the_frames_only_a_dev_build_can_load() {
    let dev_url = url(DEV_URL);
    let dev = AppOrigins {
        dev_url: Some(&dev_url),
        http_custom_protocols: false,
        framed: FRAMED.as_slice(),
    };
    assert_table(
        dev,
        &[
            "http://localhost:1420/",
            "http://localhost:1420/?file=%2FUsers%2Fa%2Fnote.md",
            "http://localhost:1420/settings",
            "vmark-trusted://doc/0123abcd",
            "about:srcdoc",
            // The Knowledge Base frame: a content server on a loopback port.
            "http://127.0.0.1:4321/__auth?t=nonce",
            "http://127.0.0.1:60999/note/A.md?s=session",
            // The video embeds, from the same CSP sources a release build uses.
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://player.vimeo.com/video/76979871",
            "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD",
        ],
        &[
            // A dev build is no wider than release for embeds: the frontend
            // never frames these, so nothing needs them.
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://youtube.com/embed/dQw4w9WgXcQ",
            "http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://evil.example:1420/",
            "http://localhost.evil.example:1420/",
            "https://evil.example/",
            "https://127.0.0.1:4321/",
            "http://127.0.0.1.evil.example/",
            "http://[::1]:4321/",
            "http://user:pw@127.0.0.1:4321/",
            "http://youtube.com.evil.example/embed/x",
            "https://evil.example/www.youtube.com/embed/x",
            "https://wwwyoutube.com/embed/x",
            "https://www.www.youtube.com/embed/x",
            "ftp://www.youtube.com/embed/x",
            "https://vimeo.com/76979871",
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "asset://localhost/%2FUsers%2Fa%2Fevil.html",
            "tauri://localhost/",
        ],
    );
}

// -- which webviews the guard governs --------------------------------------

#[test]
fn every_app_window_is_governed_and_a_pdf_render_window_is_not() {
    for label in ["main", "doc-0", "doc-17", "settings", "pdf-export", ""] {
        assert!(governs(label), "{label:?} must be governed");
    }
    assert!(!governs("pdf-render-0f8fad5bd9cb469fa16570867728950e"));
}

/// The prefix is private to two `cfg`-gated modules, so it is restated in the
/// guard. If the renderer renames its windows, they would become governed and
/// their `file:` navigation would be denied — PDF export and print dead off
/// macOS, with nothing failing here.
#[test]
fn the_render_window_prefix_is_the_one_the_pdf_renderer_uses() {
    let declaration = format!("LABEL_PREFIX: &str = \"{RENDER_WINDOW_LABEL_PREFIX}\"");
    for (file, source) in [
        ("linux.rs", include_str!("../pdf_export/renderer/linux.rs")),
        (
            "windows.rs",
            include_str!("../pdf_export/renderer/windows.rs"),
        ),
    ] {
        assert!(
            source.contains(&declaration),
            "pdf_export/renderer/{file} no longer declares {declaration}"
        );
    }
}

// -- contracts with the files this guard depends on ------------------------

fn app_csp() -> String {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri.conf.json parses");
    config["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp is a string")
        .to_string()
}

/// A frame the CSP allows and the guard denies never loads on macOS or Linux,
/// where a sub-frame navigation is judged like any other.
#[test]
fn the_guard_allows_every_frame_source_the_csp_allows() {
    let csp = app_csp();
    let sources = csp_directive_sources(&csp, "frame-src");
    assert!(!sources.is_empty(), "the CSP names no frame-src source");
    for source in sources {
        if source == "'self'" {
            continue; // the app origin, covered by the tables above
        }
        if let Some(scheme) = source.strip_suffix(':') {
            let frame = url(&format!("{scheme}://doc/0123abcd"));
            assert!(
                navigation_allowed(&frame, release()),
                "frame-src allows the {scheme}: scheme and the guard denies it"
            );
        } else if source.starts_with("https://") {
            // An outside origin: framed on every platform.
            let frame = url(&format!("{source}/0123abcd"));
            for origins in [release(), release_http()] {
                assert!(
                    navigation_allowed(&frame, origins),
                    "frame-src allows {source} and the guard denies it under {origins:?}"
                );
            }
        } else if source.starts_with("http://") {
            // The app's own frame where custom protocols ride on http.
            let frame = url(&format!("{source}/0123abcd"));
            assert!(
                navigation_allowed(&frame, release_http()),
                "frame-src allows {source} and the guard denies it"
            );
        } else {
            panic!("frame-src source {source:?} has a form the navigation guard does not know");
        }
    }
}

#[test]
fn framed_origins_reads_only_https_sources_of_frame_src() {
    let csp = "default-src 'self'; img-src https://img.example; \
               frame-src 'self' vmark-trusted: http://vmark-trusted.localhost \
               https://a.example https://b.example:8443; form-action 'none'";
    let expected: Vec<Origin> = ["https://a.example", "https://b.example:8443"]
        .iter()
        .map(|origin| url(origin).origin())
        .collect();
    assert_eq!(framed_origins(csp), expected);
    assert!(
        framed_origins("default-src 'self'").is_empty(),
        "no frame-src"
    );
    assert!(framed_origins("").is_empty(), "no CSP text");
    assert!(
        framed_origins("frame-src-elem https://a.example").is_empty(),
        "a directive is matched by its whole name"
    );
}

/// The plugin reads the CSP from the runtime config, where it can be a
/// directive map as well as one string.
#[test]
fn framed_origins_reads_a_directive_map_and_prefers_the_dev_policy_in_dev() {
    let map = |sources: &[&str]| {
        Csp::DirectiveMap(
            [(
                "frame-src".to_string(),
                tauri::utils::config::CspDirectiveSources::List(
                    sources.iter().map(|s| s.to_string()).collect(),
                ),
            )]
            .into(),
        )
    };
    let security = SecurityConfig {
        csp: Some(map(&["'self'", "https://release.example"])),
        dev_csp: Some(map(&["https://dev.example"])),
        ..SecurityConfig::default()
    };
    let read = |dev| {
        effective_csp(&security, dev)
            .map(|csp| framed_origins(&csp.to_string()))
            .unwrap_or_default()
    };
    assert_eq!(read(false), vec![url("https://release.example").origin()]);
    assert_eq!(read(true), vec![url("https://dev.example").origin()]);

    let release_only = SecurityConfig {
        csp: Some(map(&["https://release.example"])),
        ..SecurityConfig::default()
    };
    assert_eq!(
        effective_csp(&release_only, true).map(ToString::to_string),
        release_only.csp.as_ref().map(ToString::to_string),
        "a dev build without a dev policy uses the release one"
    );
    assert!(effective_csp(&SecurityConfig::default(), false).is_none());
}

/// The CSP half of the same rule: a form in document-controlled markup may
/// not post anywhere, whatever the click handling does.
#[test]
fn the_csp_forbids_every_form_submission() {
    assert_eq!(
        csp_directive_sources(&app_csp(), "form-action"),
        vec!["'none'"]
    );
}

/// Dropping the registration would leave every webview unguarded with nothing
/// else failing: a plugin that is not registered is simply never asked.
#[test]
fn the_plugin_is_registered_with_the_app() {
    assert!(
        include_str!("../app_plugins.rs").contains("navigation_guard::plugin()"),
        "app_plugins.rs no longer registers the navigation guard"
    );
}
