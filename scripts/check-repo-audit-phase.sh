#!/usr/bin/env bash
#
# DoD checker for the full-repo audit fixes plan (rule 60 §3).
# Plan: .claude/tdd-guardian/plan-20261002-full-repo-audit-fixes.md
#
# Usage: bash scripts/check-repo-audit-phase.sh <phase|all> [--root=<dir>]
#
# Exit 0 when every assertion passes, 1 when any fails, 64 on bad invocation.
# `--root` points the checker at another tree: the self-test
# (scripts/check-repo-audit-phase.test.mjs) proves both directions against
# fixture repositories. The checker's own helpers and vitest configs are used
# over that tree; its scripts/check-wi-linkage.sh is the tree's own.
#
# What a phase must show, mechanically:
#   (a) LINKED — every work item of the phase is linked: check-wi-linkage.sh
#       exits 0 for each of the phase's work-item namespaces (a phase split
#       across lanes, like RA1, has one per lane letter), and the
#       linkage gate and this checker read the same work items from the plan.
#   (b) PINNED — every work item has a test, and every such test runs. Its
#       tests are the test files whose header names it, and the test files a
#       commit tagged with it added or changed (scripts/repo-audit-evidence.mjs
#       gathers both). Each must be collected by a vitest tier and declare a
#       case, or be a Rust test cargo compiles, or a discoverable journey. A
#       work item with no test fails unless the plan marks its declaration
#       `[no-test: <reason>]` — and a mark contradicted by a test fails too.
#   (c) COMPLETE — for `all`, the phase table below and the plan's phase
#       headings agree in both directions, phase by phase down to the lane
#       namespaces; a work item declared under no phase heading fails.
# The plan is the input: an unreadable plan, a git range or a vitest list that
# cannot be read fails closed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PHASE=""
for arg in "$@"; do
  case "$arg" in
    --root=*) ROOT="${arg#--root=}" ;;
    -*) echo "unknown option: $arg" >&2; exit 64 ;;
    *)
      if [[ -n "$PHASE" ]]; then echo "expected one phase, got '$PHASE' and '$arg'" >&2; exit 64; fi
      PHASE="$arg" ;;
  esac
done
cd "$ROOT" || exit 64
PLAN=".claude/tdd-guardian/plan-20261002-full-repo-audit-fixes.md"

# The phases this checker knows, each with its work-item namespaces. Kept in
# step with the plan by assertion (c): a phase or lane added to the plan and
# not here, or left here after leaving the plan, fails `all`.
PHASE_TABLE="
RA1    RA1A RA1B
RA2    RA2
RA3    RA3
RA4    RA4
RA5    RA5
RA6    RA6
RA7    RA7
RA13a  RA13A
RA15a  RA15A
RA8    RA8
RA1C   RA1C
RA9a   RA9A
RA9b   RA9B
RA10a  RA10A
RA10b  RA10B
RA11   RA11
RA12a  RA12A
RA16   RA16
RA18   RA18
RA17   RA17A RA17C RA17D
RA13b  RA13B
RA14   RA14A RA14B RA14C
RA15b  RA15B RA15C
RA19   RA19
RA7C   RA7C
RA14E  RA14E
RA20   RA20
RA21   RA21
RA22   RA22
RA23   RA23
RA24   RA24
RA25   RA25
RA26   RA26
RA27   RA27
RA28   RA28
Wave4  RA12B RA14D RA17E RA17F RA17G
"
table_ids() { awk 'NF { print $1 }' <<<"$PHASE_TABLE"; }
table_lanes() { awk -v p="$1" '$1 == p { for (i = 2; i <= NF; i++) print $i }' <<<"$PHASE_TABLE" | sort; }

usage() {
  echo "Usage: $0 <phase|all> [--root=<dir>]"
  echo "  phases: $(table_ids | tr '\n' ' ')"
  echo "  all     every phase, plus the table-to-plan agreement"
  exit 64
}
[[ -z "$PHASE" ]] && usage

source "$SCRIPT_DIR/lib/dod-assertions.sh"
summary() {
  echo
  echo "Phase $PHASE: $PASS passed, $FAIL failed."
  if (( FAIL > 0 )); then echo "Not done:"; for d in "${FAIL_DETAIL[@]}"; do echo "  - $d"; done; exit 1; fi
  exit 0
}

# ── The plan, read once ──────────────────────────────────────────────────
if [[ ! -r "$PLAN" ]]; then fail "plan unreadable: $ROOT/$PLAN — nothing can be checked"; summary; fi
LINKAGE="scripts/check-wi-linkage.sh"
if [[ ! -f "$LINKAGE" ]]; then fail "$LINKAGE missing in $ROOT — linkage cannot be checked"; summary; fi
WHOLE="$(bash "$LINKAGE" "$PLAN" 2>&1)"
RANGE="$(sed -n 's/^Commit range: //p' <<<"$WHOLE")"
if [[ -z "$RANGE" ]]; then
  fail "check-wi-linkage.sh read no work items from $PLAN, so no commit range: $(tail -n 3 <<<"$WHOLE" | tr '\n' ' ')"
  summary
fi
EV_ERR="$(mktemp "${TMPDIR:-/tmp}/repo-audit-phase.XXXXXX")"
trap 'rm -f "$EV_ERR"' EXIT
if ! EV="$(node "$SCRIPT_DIR/repo-audit-evidence.mjs" "$ROOT" "$PLAN" "$RANGE" 2>"$EV_ERR")"; then
  fail "evidence could not be gathered: $(cat "$EV_ERR")"; summary
fi
plan_ids() { awk -F'\t' '$1 == "PHASE" { print $2 }' <<<"$EV"; }
plan_lanes() {
  awk -F'\t' -v p="$1" '$1 == "WI" && $2 == p { id = $3; sub(/^WI-/, "", id); sub(/\.[0-9]+[a-z]?$/, "", id); print id }' <<<"$EV" | sort -u
}
in_list() { grep -Fxq -- "$1" <<<"$2"; }

check_plan() {
  echo "Plan — $PLAN"
  local ours theirs only
  ours="$(awk -F'\t' '$1 == "WI" { print $3 } $1 == "ORPHAN" { print $2 }' <<<"$EV" | sort -u)"
  theirs="$(grep -oE '^  [✓✗] WI-[^ ]+' <<<"$WHOLE" | awk '{ print $2 }' | sort -u)"
  only="$(comm -23 <(echo "$ours") <(echo "$theirs") | tr '\n' ' ')"
  if [[ -n "${only// }" ]]; then fail "work items this checker reads but check-wi-linkage.sh does not: $only"; fi
  only="$(comm -13 <(echo "$ours") <(echo "$theirs") | tr '\n' ' ')"
  if [[ -n "${only// }" ]]; then fail "work items check-wi-linkage.sh reads but this checker does not: $only"; fi
  [[ "$ours" == "$theirs" ]] && ok "the plan's $(wc -l <<<"$ours" | tr -d ' ') work items read alike by this checker and check-wi-linkage.sh"
  local orphan
  while IFS=$'\t' read -r _ id line; do
    fail "$id (plan line $line) is declared under no phase heading"
  done < <(awk -F'\t' '$1 == "ORPHAN"' <<<"$EV")
  local lane owners
  while read -r lane; do
    owners="$(awk -F'\t' -v l="$lane" '$1 == "WI" { id = $3; sub(/^WI-/, "", id); sub(/\.[0-9]+[a-z]?$/, "", id); if (id == l) print $2 }' <<<"$EV" | sort -u | tr '\n' ' ')"
    [[ "$(wc -w <<<"$owners")" -gt 1 ]] && fail "namespace WI-$lane.* spans phases $owners— its linkage cannot be gated per phase"
  done < <(awk -F'\t' '$1 == "WI" { id = $3; sub(/^WI-/, "", id); sub(/\.[0-9]+[a-z]?$/, "", id); print id }' <<<"$EV" | sort -u)
}

check_table() {
  echo "Phase table — scripts/check-repo-audit-phase.sh"
  local p plans table
  plans="$(plan_ids)"; table="$(table_ids)"
  while read -r p; do
    [[ -z "$p" ]] && continue
    if in_list "$p" "$table"; then ok "phase $p is in the plan and in the table"
    else fail "phase $p is in the plan but not in this checker's table"; fi
  done <<<"$plans"
  while read -r p; do
    in_list "$p" "$plans" || fail "phase $p is in this checker's table but not in the plan"
  done <<<"$table"
}

check_phase() {
  local p="$1" lanes want lane out rc
  echo
  echo "Phase $p"
  if ! in_list "$p" "$(plan_ids)"; then fail "phase $p: no '#### Phase $p —' heading in the plan"; return; fi
  lanes="$(plan_lanes "$p")"
  if [[ -z "$lanes" ]]; then fail "phase $p declares no work items"; return; fi
  want="$(table_lanes "$p")"
  if [[ "$lanes" != "$want" ]]; then
    fail "phase $p namespaces differ — plan: $(tr '\n' ' ' <<<"$lanes")table: $(tr '\n' ' ' <<<"$want")"
  fi
  # (a) linkage, one run per namespace
  while read -r lane; do
    out="$(bash "$LINKAGE" "$PLAN" --phase="$lane" 2>&1)"; rc=$?
    if (( rc == 0 )); then ok "WI-$lane.* linked ($(sed -n 's/^WIs found: \([0-9]*\).*/\1/p' <<<"$out") work items)"
    else
      fail "WI-$lane.* linkage (check-wi-linkage.sh --phase=$lane exit $rc)"
      grep -E '✗' <<<"$out" | sed 's/^/      | /'
    fi
  done <<<"$lanes"
  # (b) every work item has a test, or an honest no-test mark
  local wi reason have gone
  while IFS=$'\t' read -r _ _ wi reason; do
    have="$(awk -F'\t' -v w="$wi" '$1 == "EVIDENCE" && $2 == w && $5 != "missing" { print $4 }' <<<"$EV" | sort -u)"
    gone="$(awk -F'\t' -v w="$wi" '$1 == "EVIDENCE" && $2 == w && $5 == "missing" { print $4 }' <<<"$EV" | sort -u | tr '\n' ' ')"
    [[ -n "${gone// }" ]] && echo "  ⓘ $wi: a tagged commit touched $gone— no longer in the tree"
    if [[ -n "$reason" && -n "$have" ]]; then fail "$wi is marked [no-test: $reason] but has tests: $(tr '\n' ' ' <<<"$have")— remove the mark"
    elif [[ -n "$reason" ]]; then ok "$wi needs no test (plan: $reason)"
    elif [[ -z "$have" ]]; then fail "$wi has no test: no test-file header names it and no commit tagged ($wi) added or changed a test — write one, or mark the declaration [no-test: <reason>] if it changed no behaviour"
    else ok "$wi pinned by $(wc -l <<<"$have" | tr -d ' ') test file(s)"; fi
  done < <(awk -F'\t' -v p="$p" '$1 == "WI" && $2 == p' <<<"$EV")
  # (b) every test those work items rely on runs
  local file state wis
  while IFS=$'\t' read -r file state wis; do
    case "$state" in
      vitest|cargo) assert_test_file "$file" "$file ($wis)" ;;
      journey) assert_journey "$file" "$file ($wis)" ;;
      *) fail "$file ($wis) is named as a test, but no vitest tier collects it" ;;
    esac
  done < <(awk -F'\t' -v p="$p" '
    $1 == "WI" && $2 == p { mine[$3] = 1 }
    $1 == "EVIDENCE" && ($2 in mine) && $5 != "missing" {
      if (!($4 in state)) { order[++n] = $4; state[$4] = $5 }
      if (index("," who[$4] ",", "," $2 ",") == 0) who[$4] = who[$4] (who[$4] ? "," : "") $2
    }
    END { for (i = 1; i <= n; i++) print order[i] "\t" state[order[i]] "\t" who[order[i]] }' <<<"$EV")
}

check_plan
if [[ "$PHASE" == "all" ]]; then
  check_table
  while read -r p; do check_phase "$p"; done < <( { plan_ids; table_ids; } | awk '!seen[$0]++')
elif in_list "$PHASE" "$(table_ids)" || in_list "$PHASE" "$(plan_ids)"; then
  in_list "$PHASE" "$(table_ids)" || fail "phase $PHASE is in the plan but not in this checker's table"
  check_phase "$PHASE"
else
  echo "unknown phase: $PHASE" >&2; usage
fi
summary
