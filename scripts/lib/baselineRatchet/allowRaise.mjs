/**
 * The allowRaise reconciliation of the baseline ratchet: which observed raises
 * the manifest's `allowRaise` entries explain.
 *
 * Purpose: an allowRaise entry permits exactly ONE re-measurement. It must
 * name the raise that actually happened (same from → to), carry a reason, and
 * it fails as STALE once no such raise exists against the merge base — which
 * is what makes the exemption expire by itself instead of standing forever.
 * Pure: raises in, failures, notices and the unexplained raises out.
 *
 * @coordinates-with scripts/baselineRatchetModes.mjs — re-exports this beside the comparison modes
 * @coordinates-with scripts/check-baseline-ratchet.mjs — the CLI that reports the result
 * @module scripts/lib/baselineRatchet/allowRaise
 */

/**
 * Reconcile observed raises against the manifest's allowRaise entries.
 * A declared raise that did not happen is STALE — that is what makes the
 * exemption one-shot rather than permanent.
 */
export function reconcileAllowRaise(allowRaise, raises) {
  const failures = [];
  const notices = [];
  const consumed = new Set();

  for (const entry of allowRaise) {
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      failures.push(`allowRaise for ${entry.path}:${entry.key} has no reason — state why, or delete it.`);
      continue;
    }
    const idx = raises.findIndex((r) => r.path === entry.path && r.key === entry.key && !consumed.has(r));
    const match = idx === -1 ? undefined : raises[idx];
    if (!match) {
      failures.push(
        `stale allowRaise: ${entry.path}:${entry.key} declares ${entry.from} → ${entry.to}, but no such ` +
          "raise exists against this merge base (it has already landed, or the value changed). Delete it.",
      );
      continue;
    }
    if (match.from !== entry.from || match.to !== entry.to) {
      failures.push(
        `allowRaise mismatch: ${entry.path}:${entry.key} permits ${entry.from} → ${entry.to}, ` +
          `but the actual change is ${match.from} → ${match.to}.`,
      );
      continue;
    }
    consumed.add(match);
    notices.push(`allowed raise: ${entry.path}:${entry.key} ${entry.from} → ${entry.to}`);
    notices.push(`    reason: ${entry.reason}`);
  }

  const unexplained = raises.filter((r) => !consumed.has(r));
  return { failures, notices, unexplained };
}
