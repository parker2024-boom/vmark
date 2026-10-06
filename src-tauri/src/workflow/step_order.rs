//! The order steps run in (split from `runner.rs` at the file-size limit).
//!
//! Steps are sorted topologically on their `needs:` edges with Kahn's
//! algorithm; steps with no unmet dependency keep their declaration order.
//!
//! Key decisions:
//!   - A step with no `id:` takes the last segment of its `uses:`.
//!   - A duplicate id, a `needs:` naming no step, and a cycle are errors, never
//!     silently dropped steps.
//!   - `run_workflow` runs this sort at ADMISSION too, so a malformed graph is
//!     refused before a run is spawned rather than by the run.
//!
//! @coordinates-with runner.rs — sorts, then runs the steps in this order
//! @coordinates-with validate.rs — the admission-time caller
//! @module workflow::step_order

use crate::workflow::types::RawStep;
use std::collections::{HashMap, HashSet, VecDeque};

/// A resolved step with its ID and dependencies.
#[derive(Debug)]
pub(in crate::workflow) struct ResolvedStep {
    pub(super) id: String,
    pub(super) step: RawStep,
    pub(super) needs: Vec<String>,
}

/// Topologically sort steps by `needs:`; no-dep steps first. `run_workflow`
/// runs it at ADMISSION too, so it does not fail for a spawned run.
pub(in crate::workflow) fn topological_sort(
    steps: Vec<RawStep>,
) -> Result<Vec<ResolvedStep>, String> {
    // Build resolved steps with IDs
    let mut resolved: Vec<ResolvedStep> = Vec::new();
    let mut id_set: HashSet<String> = HashSet::new();

    for step in steps {
        let id = step.id.clone().unwrap_or_else(|| {
            step.uses
                .split('/')
                .next_back()
                .unwrap_or("step")
                .to_string()
        });
        let needs = step.needs.to_vec();
        // Duplicate IDs would silently overwrite earlier steps in step_map
        // below, dropping work — fail loudly instead.
        if !id_set.insert(id.clone()) {
            return Err(format!(
                "Duplicate step id '{}' — every step needs a unique id",
                id
            ));
        }
        resolved.push(ResolvedStep { id, step, needs });
    }

    // Validate all needs references exist
    for rs in &resolved {
        for dep in &rs.needs {
            if !id_set.contains(dep) {
                return Err(format!(
                    "Step '{}' depends on unknown step '{}'",
                    rs.id, dep
                ));
            }
        }
    }

    // Kahn's algorithm for topological sort
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();

    for rs in &resolved {
        in_degree.entry(rs.id.clone()).or_insert(0);
        adjacency.entry(rs.id.clone()).or_default();
        for dep in &rs.needs {
            adjacency
                .entry(dep.clone())
                .or_default()
                .push(rs.id.clone());
            *in_degree.entry(rs.id.clone()).or_insert(0) += 1;
        }
    }

    let mut queue: VecDeque<String> = VecDeque::new();
    // Seed with steps that have no dependencies, preserving declaration order
    for rs in &resolved {
        if *in_degree.get(&rs.id).unwrap_or(&0) == 0 {
            queue.push_back(rs.id.clone());
        }
    }

    let mut sorted_ids: Vec<String> = Vec::new();
    while let Some(id) = queue.pop_front() {
        sorted_ids.push(id.clone());
        if let Some(dependents) = adjacency.get(&id) {
            for dep_id in dependents {
                if let Some(deg) = in_degree.get_mut(dep_id) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(dep_id.clone());
                    }
                }
            }
        }
    }

    if sorted_ids.len() != resolved.len() {
        return Err(rust_i18n::t!("errors.workflow.circularDependency").to_string());
    }

    // Reorder resolved steps by sorted order
    let mut step_map: HashMap<String, ResolvedStep> =
        resolved.into_iter().map(|rs| (rs.id.clone(), rs)).collect();
    let mut ordered = Vec::new();
    for id in sorted_ids {
        if let Some(rs) = step_map.remove(&id) {
            ordered.push(rs);
        }
    }

    Ok(ordered)
}

#[cfg(test)]
#[path = "step_order.test.rs"]
mod tests;
