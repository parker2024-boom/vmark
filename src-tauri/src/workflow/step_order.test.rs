// WI-RA5.3 — the step order, split out of the runner: `needs:` edges are
// honoured, and a graph that cannot be ordered is an error.
//
//! Unit tests for `step_order.rs`.

use super::*;
use crate::workflow::types::NeedsDef;

#[test]
fn test_topological_sort_sequential() {
    let steps = vec![
        RawStep {
            id: Some("a".into()),
            uses: "action/read-file".into(),
            with: HashMap::new(),
            needs: NeedsDef::None,
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: Some("b".into()),
            uses: "genie/summarize".into(),
            with: HashMap::new(),
            needs: NeedsDef::Single("a".into()),
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
    ];
    let sorted = topological_sort(steps).unwrap();
    assert_eq!(sorted[0].id, "a");
    assert_eq!(sorted[1].id, "b");
}

#[test]
fn test_topological_sort_fan_out() {
    let steps = vec![
        RawStep {
            id: Some("read".into()),
            uses: "action/read-folder".into(),
            with: HashMap::new(),
            needs: NeedsDef::None,
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: Some("sum".into()),
            uses: "genie/summarize".into(),
            with: HashMap::new(),
            needs: NeedsDef::Single("read".into()),
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: Some("translate".into()),
            uses: "genie/translate".into(),
            with: HashMap::new(),
            needs: NeedsDef::Single("read".into()),
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: Some("save".into()),
            uses: "action/save-file".into(),
            with: HashMap::new(),
            needs: NeedsDef::List(vec!["sum".into(), "translate".into()]),
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
    ];
    let sorted = topological_sort(steps).unwrap();
    // "read" must come first, "save" must come last
    assert_eq!(sorted[0].id, "read");
    assert_eq!(sorted[3].id, "save");
    // "sum" and "translate" are in between (order among them doesn't matter)
    let middle: HashSet<&str> = [sorted[1].id.as_str(), sorted[2].id.as_str()].into();
    assert!(middle.contains("sum"));
    assert!(middle.contains("translate"));
}

#[test]
fn test_topological_sort_circular() {
    let steps = vec![
        RawStep {
            id: Some("a".into()),
            uses: "action/read-file".into(),
            with: HashMap::new(),
            needs: NeedsDef::Single("b".into()),
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: Some("b".into()),
            uses: "genie/summarize".into(),
            with: HashMap::new(),
            needs: NeedsDef::Single("a".into()),
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
    ];
    let result = topological_sort(steps);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Circular"));
}

#[test]
fn test_topological_sort_missing_dep() {
    let steps = vec![RawStep {
        id: Some("a".into()),
        uses: "action/read-file".into(),
        with: HashMap::new(),
        needs: NeedsDef::Single("nonexistent".into()),
        condition: None,
        model: None,
        approval: None,
        limits: None,
    }];
    let result = topological_sort(steps);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("unknown step"));
}

#[test]
fn test_topological_sort_rejects_duplicate_ids() {
    let steps = vec![
        RawStep {
            id: Some("dup".into()),
            uses: "action/read-file".into(),
            with: HashMap::new(),
            needs: NeedsDef::None,
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: Some("dup".into()),
            uses: "action/save-file".into(),
            with: HashMap::new(),
            needs: NeedsDef::None,
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
    ];
    let result = topological_sort(steps);
    assert!(
        result.is_err(),
        "duplicate ids must not be silently dropped"
    );
    assert!(result.unwrap_err().contains("dup"));
}

#[test]
fn test_topological_sort_rejects_duplicate_derived_ids() {
    // Two id-less steps using the same action derive the same id.
    let steps = vec![
        RawStep {
            id: None,
            uses: "action/notify".into(),
            with: HashMap::new(),
            needs: NeedsDef::None,
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
        RawStep {
            id: None,
            uses: "action/notify".into(),
            with: HashMap::new(),
            needs: NeedsDef::None,
            condition: None,
            model: None,
            approval: None,
            limits: None,
        },
    ];
    assert!(topological_sort(steps).is_err());
}
