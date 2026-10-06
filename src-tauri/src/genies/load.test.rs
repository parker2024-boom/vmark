//! WI-RA10B.9 — `load_genies` returns every genie with its content in one
//! answer, keeps a bad file from costing the others, and bounds the answer.

use super::{load_genies_bounded, load_genies_in, LoadedGenie, MAX_BATCH_TEMPLATE_BYTES};
use crate::command_error::ErrorCode;
use crate::genies::types::GenieKind;
use std::fs;
use std::path::{Path, PathBuf};

const MARKDOWN_GENIE: &str = "---\ndescription: Improve clarity and flow\nscope: selection\n\
---\n\nImprove the following text:\n\n{{content}}\n";

const WORKFLOW_GENIE: &str = "name: Outline and polish\ndescription: Two steps\nsteps: []\n";

/// A temp genies directory; the handle keeps it alive.
fn genies_dir() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().expect("tempdir");
    let genies = root.path().join("genies");
    fs::create_dir_all(&genies).expect("mkdir genies");
    (root, genies)
}

fn write(dir: &Path, relative: &str, content: impl AsRef<[u8]>) {
    let path = dir.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    fs::write(path, content).expect("write genie");
}

fn names(loaded: &[LoadedGenie]) -> Vec<&str> {
    loaded.iter().map(|g| g.entry.name.as_str()).collect()
}

#[test]
fn every_genie_comes_back_with_its_content_sorted_by_name() {
    let (_root, genies) = genies_dir();
    write(&genies, "writing/polish.md", MARKDOWN_GENIE);
    write(&genies, "flows/outline.yml", WORKFLOW_GENIE);
    write(&genies, "alpha.md", MARKDOWN_GENIE);

    let loaded = load_genies_in(&genies);

    assert_eq!(names(&loaded), ["alpha", "outline", "polish"]);
    for genie in &loaded {
        assert!(genie.error.is_none(), "{:?}", genie.error);
        let content = genie.content.as_ref().expect("content");
        assert_eq!(content.metadata.name, genie.entry.name);
    }
    assert_eq!(loaded[1].entry.kind, GenieKind::Workflow);
    assert_eq!(loaded[1].content.as_ref().unwrap().template, WORKFLOW_GENIE);
    assert_eq!(loaded[2].entry.category.as_deref(), Some("writing"));
    assert!(loaded[2]
        .content
        .as_ref()
        .unwrap()
        .template
        .contains("{{content}}"));
}

#[test]
fn a_missing_or_empty_genies_dir_loads_nothing() {
    let (root, genies) = genies_dir();
    assert!(load_genies_in(&genies).is_empty());
    assert!(load_genies_in(&root.path().join("absent")).is_empty());
}

#[test]
fn a_genie_that_cannot_be_read_carries_its_error_and_the_others_still_load() {
    let (_root, genies) = genies_dir();
    write(&genies, "good.md", MARKDOWN_GENIE);
    write(&genies, "broken.yml", "just a scalar\n");
    write(&genies, "binary.md", [0xff, 0xfe, 0x00]);

    let loaded = load_genies_in(&genies);

    assert_eq!(names(&loaded), ["binary", "broken", "good"]);
    for bad in &loaded[..2] {
        assert!(bad.content.is_none());
        assert_eq!(
            bad.error.as_ref().expect("error").code(),
            ErrorCode::InvalidInput
        );
    }
    assert!(loaded[2].content.is_some() && loaded[2].error.is_none());
}

#[test]
fn a_genie_with_a_cjk_name_loads() {
    let (_root, genies) = genies_dir();
    write(&genies, "写作/润色.md", MARKDOWN_GENIE);

    let loaded = load_genies_in(&genies);

    assert_eq!(names(&loaded), ["润色"]);
    assert_eq!(loaded[0].entry.category.as_deref(), Some("写作"));
    assert!(loaded[0].content.is_some());
}

#[test]
fn genies_past_the_answer_budget_come_back_listed_but_unread() {
    let (_root, genies) = genies_dir();
    let template = "x".repeat(600);
    for name in ["a", "b", "c"] {
        write(
            &genies,
            &format!("{name}.md"),
            format!("---\ndescription: d\n---\n{template}"),
        );
    }

    // Room for one template, not two.
    let loaded = load_genies_bounded(&genies, 1_000);

    assert_eq!(names(&loaded), ["a", "b", "c"]);
    assert!(loaded[0].content.is_some());
    for deferred in &loaded[1..] {
        assert!(deferred.content.is_none() && deferred.error.is_none());
    }
}

#[test]
fn a_small_genie_after_a_large_one_still_fits_the_budget() {
    let (_root, genies) = genies_dir();
    write(
        &genies,
        "a.md",
        format!("---\ndescription: d\n---\n{}", "x".repeat(900)),
    );
    write(
        &genies,
        "b.md",
        format!("---\ndescription: d\n---\n{}", "x".repeat(900)),
    );
    write(&genies, "c.md", "---\ndescription: d\n---\nshort");

    let loaded = load_genies_bounded(&genies, 1_000);

    assert!(loaded[0].content.is_some());
    assert!(loaded[1].content.is_none() && loaded[1].error.is_none());
    assert!(loaded[2].content.is_some());
}

#[test]
fn the_default_budget_holds_several_genies_of_the_largest_size() {
    assert!(MAX_BATCH_TEMPLATE_BYTES as u64 >= 4 * crate::genies::commands::MAX_GENIE_BYTES);
}

#[test]
fn the_wire_shape_is_the_entry_with_content_or_error_beside_it() {
    let (_root, genies) = genies_dir();
    write(&genies, "good.md", MARKDOWN_GENIE);
    write(&genies, "broken.yml", "just a scalar\n");

    let wire = serde_json::to_value(load_genies_in(&genies)).expect("serialize");

    let broken = &wire[0];
    assert_eq!(broken["name"], "broken");
    assert_eq!(broken["kind"], "workflow");
    assert_eq!(broken["error"]["code"], "invalid-input");
    assert!(broken.get("content").is_none());

    let good = &wire[1];
    assert_eq!(good["name"], "good");
    assert_eq!(good["source"], "global");
    assert!(good["path"].as_str().unwrap().ends_with("good.md"));
    assert_eq!(
        good["content"]["metadata"]["description"],
        "Improve clarity and flow"
    );
    assert!(good.get("error").is_none());
}
