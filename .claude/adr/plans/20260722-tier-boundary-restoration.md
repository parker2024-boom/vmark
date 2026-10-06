# Decisions — Tier Boundary Restoration (H4 burn-down)

> Plan: `dev-docs/plans/20260722-tier-boundary-restoration.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: tier-boundary restoration (the `use*` naming rule for hooks).
> Defines: ADR-1, ADR-2. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

## ADR-1: `use*` is reserved for React hooks

A module exporting no hook must not carry the `use` prefix. React's own lint
rules treat the prefix as a semantic marker, and the misleading names are the
most plausible cause of this drift — a reader importing `useFileOpen` reasonably
assumes it belongs in the React tier.

Every import path changes with the move regardless, so renaming costs
approximately nothing extra at the call sites.

## ADR-2: re-key the size baseline rather than split

`useHistoryOperations.ts` (369), `useFileOpen.ts` (309), and
`useUnifiedHistory.ts` (307) exceed the 300-line limit and are frozen in
`scripts/file-size-baseline.json` under their `src/hooks/` paths. Moving them
creates paths the gate reads as *new* violations, failing `pnpm check:all`.

`.claude/rules/00-engineering-principles.md` says the baseline ratchets down
only. Re-keying preserves that: the same line counts move to the same files at
new paths, and no number rises. Splitting these three is genuine design work and
belongs in its own pass, not smuggled into a move commit where it would
dominate the diff.

**Constraint:** re-keying is path-rename only. If any re-keyed number would
increase, the move is wrong and must stop.
