# Decisions — Durable ledger store + git-revert auto-repair (Option 1)

> Plan: `dev-docs/plans/20260721-coherence-durable-ledger-store.md` — written on the coherence runtime branch and never merged to `main` as a file.
> Built: the coherence durable ledger store.
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1 — Sealed content-addressed chunks + one bounded active tail

- **Sealed chunk** — immutable JSONL, identity = SHA-256 of its exact bytes.
  On-disk name embeds the hash so identity is collision-free even across
  same-WriterId branches (review #2): `{writer}-{seq:06}-{hash16}.jsonl`, where
  `hash16` is the first 16 hex of the content SHA-256 and `seq` is **display
  metadata only**, never identity. `merge=union` cannot mutate a sealed file:
  two branches that sealed different content produce different `hash16` → distinct
  filenames → no union conflict. (Same content ⇒ same name ⇒ idempotent.)
- **Active tail** — the single appendable file `{writer}.tail.jsonl`. Distinct
  suffix (`.tail.jsonl`) so migration and listing never confuse it with a sealed
  chunk. Bounded to `SEAL_THRESHOLD` (candidate 4 MiB — see review #6 / §4.4).

### ADR-2 — Applied-state in the disposable index (review suggested #1)

```sql
CREATE TABLE applied_chunks (
  chunk_hash  TEXT PRIMARY KEY,   -- full sha256 of sealed bytes = identity
  file_name   TEXT NOT NULL,      -- {writer}-{seq}-{hash16}.jsonl (display/locate)
  writer      TEXT NOT NULL,
  byte_len    INTEGER NOT NULL,
  git_oid     TEXT,               -- HEAD blob OID when applied; NULL if uncommitted
  format_gen  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE applied_tail (
  writer      TEXT PRIMARY KEY,
  offset      INTEGER NOT NULL,   -- bytes of tail applied
  prefix_hash TEXT NOT NULL       -- sha256 of tail[0..offset]
) WITHOUT ROWID;
CREATE TABLE reconcile_state (
  k TEXT PRIMARY KEY, v TEXT      -- e.g. last_head_sha (survives restart, review #8)
) WITHOUT ROWID;
-- canonical idem winner (review #3): rebuild if a new envelope beats the stored winner
CREATE TABLE applied_winner (
  idem TEXT PRIMARY KEY, sort_key TEXT NOT NULL
) WITHOUT ROWID;
```

`PRAGMA user_version` bump ⇒ mismatch forces a full rebuild = the migration path.

### ADR-3 — Canonical-winner-preserving delta replay (review #3)

`read_all` keeps the smallest `(time,id)` per idem; naive first-applied replay
diverges when a later-arriving chunk holds a smaller winner (clock skew across a
seal boundary). Rule: on replaying an entry whose idem is already in
`applied_winner`, compare sort keys. New key **larger** → ignore (loser).
New key **smaller** → it replaces the canonical winner → **force full rebuild**
(a determinate, rare event; correctness over cleverness). Reconcile returns the
typed outcome `CanonicalWinnerChanged` (review suggested #3).

### ADR-4 — Reconcile = detect topology → repair → apply delta → else rebuild

Typed outcomes: `DeltaApplied`, `CanonicalWinnerChanged`, `LedgerRewind`,
`CorruptChunk`, `UnavailableEvidence`, `FullRebuild`.

On the outermost `with_write_lock` acquire (under the flock):

1. **Topology first (review #8).** Read `reconcile_state.last_head_sha`; observe
   current HEAD (`gitops`). This happens BEFORE any destructive step, and works on
   reopen because `last_head_sha` is persisted, not the in-memory `last_git`.
2. **Applied-skip oracle (§3).** One `git ls-tree` (if git). Partition sealed
   chunks into unchanged-committed (skip), changed/removed-committed (→ 4/5), and
   uncommitted (hash).
3. **Rewind check (§8).** If applied chunks were removed/changed AND git classifies
   the HEAD move as MUTATION → `LedgerRewind` → §8 repair BEFORE reconciling away
   the pre-revert head. Never rebuild first.
4. **Apply new sealed chunks** (uncommitted-new or freshly committed-new): validate
   + apply each in **one SQLite transaction per chunk** (review #5), updating
   `applied_chunks` + `applied_winner` atomically.
5. **Tail delta.** Re-hash `tail[0..offset]`; equal → replay after `offset` (O(new
   bytes)); unequal → tail was externally rewritten → `FullRebuild` (§7).
6. Persist `last_head_sha`. Common case touches only new bytes + one git call.

### ADR-5 — Seal/reset durable-state machine (review #4, #5)

Sealing must be crash-certifiable. Ordered, each step durable before the next:

1. Write the sealed chunk to `tmp` (content = current tail bytes), fsync, rename
   to `{writer}-{seq}-{hash16}.jsonl`, fsync parent dir. *(chunk now durable)*
2. In one SQLite txn, insert its `applied_chunks` row + fold its entries into
   `applied_winner`. *(index knows the chunk)*
3. Atomically replace the tail with a fresh empty file (write empty `tmp`, fsync,
   rename over `{writer}.tail.jsonl`, fsync dir); reset `applied_tail` to (0, hash("")).

Recoverable durable states and their reconcile handling:

| Durable state after crash | Reconcile sees | Action |
|---|---|---|
| old tail only (pre-seal) | tail unsealed, prefix matches | replay tail delta — normal |
| sealed chunk written, txn not committed | new chunk on disk, absent from `applied_chunks` | apply it (step 4) — idempotent by content hash |
| chunk applied, tail not yet reset | chunk in `applied_chunks`; tail still full | tail prefix still matches `applied_tail`; replay re-sees already-applied entries → **deduped by idem** — safe |
| tail reset, `applied_tail` not reset | empty tail; `applied_tail.offset>0` | prefix hash of empty tail ≠ stored → detected; reset to (0,·) |
| fully sealed | fresh tail, chunk applied | normal |

Re-sealing after a crash reuses the **same content-addressed name** (same bytes ⇒
same hash16) — never allocates a second chunk (review #4).

### ADR-6 — Oversized legal entry seals immediately (review #6)

`MAX_LINE_BYTES` is 16 MiB; a group-prepare may be 4 MiB. If an entry would push
the tail past `SEAL_THRESHOLD`, the tail is sealed first; if the entry **alone**
exceeds `SEAL_THRESHOLD`, it is written as its **own one-entry sealed chunk**
directly (never buffered in the bounded tail). So the tail stays ≤ `SEAL_THRESHOLD`
and every legal entry has a home. `SEAL_THRESHOLD` is chosen from SP-0.1 (tail
re-hash cost) but MUST NOT be the reason a legal entry is unwritable — the
one-entry-chunk rule removes that coupling. Delta checkpointing handles torn final
lines, oversized lines, quarantine, and future-format entries **identically to
`read_all`** (shared parsing; SP-0.8 asserts equivalence).

### ADR-7 — Migration around the real legacy layout (review #7)

Legacy layout: per-writer `{writer}.jsonl`, `{writer}-{NNN}.jsonl`; the **active
file is the highest suffix** (`ledger.rs::active_segment`). Migration (one
crash-certifiable operation, gated by `user_version`):

1. Full `read_all()` + `rebuild_from()` (unchanged) → derived index.
2. Recompute canonical `applied_winner` for every idem.
3. Convert each legacy segment **except the active one** into a sealed chunk:
   compute its hash, record `applied_chunks` (+ `git_oid` from `ls-tree` if
   committed). The files may keep their legacy names — `file_name` locates them;
   identity is the hash. (No rename needed; avoids touching git history.)
4. Convert the active legacy segment into the new tail: record `applied_tail` =
   (len, prefix_hash) over its current bytes.
5. Bump `user_version` LAST, as the commit point. A crash before it re-runs the
   whole migration (idempotent — content-addressed).

Mixed old/new branches: a branch created pre-migration merges in legacy-named
segments; §3's `ls-tree` + content hashing treat them uniformly (name is not
identity).
