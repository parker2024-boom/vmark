# Decisions — Genie Execution Inside YAML Workflows

> Plan: `dev-docs/plans/20260418-genie-in-workflow.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: genie steps inside YAML workflows (`src-tauri/src/workflow/`, `src-tauri/src/genies/`, `src-tauri/src/ai_provider/sink.rs`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: Sink abstraction for AI provider output (not event loopback, not code duplication)

**Decision:** Introduce a single `AiSink` trait in `src-tauri/src/ai_provider/sink.rs` with two implementations: `WindowSink` (emits `ai:response` events — today's behavior) and `ChannelSink` (sends chunks to a tokio mpsc channel — new). Refactor `cli.rs`, `rest_providers.rs`, and `rest_api.rs` to emit through `&dyn AiSink` instead of a bare `&WebviewWindow`. Add `run_ai_prompt_collect(...) -> Result<String, String>` that drives a `ChannelSink` and awaits the full response.

**Context:** The workflow runner runs as a background tokio task; it needs the AI result as a string, not a stream of window events. Three options were considered:

| Option | Pros | Cons |
|---|---|---|
| A. Duplicate provider fns into `_collect` siblings | Zero refactor to streaming path | Doubles ~500 LOC of provider code; drift hazard forever |
| B. `AiSink` trait with two impls (chosen) | One code path; ~30 lines of new abstraction; providers unchanged in shape | Touches 5 provider fns (~5–15 lines each) |
| C. Event loopback — emit to window, listen in Rust | Zero change to providers | Pings the whole frontend for every chunk of every internal genie call; complicates lifetime of listeners; harder to reason about cancellation |

**Consequences:** One emission path for both UI streaming and in-process collection. Future consumers (MCP workflow trigger, headless scripting) also get the collector for free. Providers now depend on `sink::AiSink` instead of `WebviewWindow` directly — the public command `run_ai_prompt` constructs a `WindowSink` and keeps its current signature.

### ADR-2: Template binding — every `with:` key becomes `{{key}}`; `{{content}}` and `{{context}}` are v0 compatibility aliases

**Decision:** Move template filling into Rust (`src-tauri/src/workflow/template.rs`). Substitution rules (in this precedence):

1. `{{input}}` → `with.input` (required for v1 genies).
2. `{{content}}` → `with.content` if present, else `with.input`. **Fatal error if neither is present** and the template contains `{{content}}`.
3. `{{context}}` → `with.context` if present, else the empty string. Never fatal (context was always editor-side extraction; dropping it in workflow mode is the honest degradation).
4. `{{key}}` → `with.key` for every other key in the step's `with:` map.
5. **Unbound placeholders are a fatal step error.** The executor returns `Err("Unbound placeholders: {{foo}}, {{bar}}")` listing every unresolved name. No LLM call is made.

**Context:** Existing genies use `{{content}}` and `{{context}}` filled by editor extraction. Workflow steps supply `with:` key/value pairs and have no editor. V1 genies declare `input.type`/`output.type` but the template body still uses `{{content}}`-like placeholders. We need a binding that works for both v0 and v1 authored templates without magic.

The original draft of this ADR made unbound placeholders a soft warning. That was wrong: shipping a prompt containing literal `{{foo}}` to the LLM produces silently-wrong output and the step reports "success" — the worst possible failure mode. Fatal is correct; the two v0 aliases are the only semantically-safe relaxations.

**Consequences:** V0 genies run unmodified in workflows as long as the caller supplies `with.input` (or `with.content`). V1 genies get a real contract: every `{{placeholder}}` in the template must resolve, or the step fails before any token is spent. `{{context}}` in v0 templates degrades to empty string in workflow mode — genies that genuinely depend on editor context must supply `with.context` explicitly.

### ADR-3: Expression syntax — `${{ steps.ID.outputs.FIELD }}` with `stepId.output` alias

**Decision:** Extend `resolve_params` in `runner.rs` to support:

- `${{ env.NAME }}` — environment variable (new explicit form).
- `${NAME}` — environment variable (existing form, preserved).
- `${{ steps.ID.outputs.FIELD }}` — structured step output.
- `${{ steps.ID.output }}` — default/text output (sugar for `${{ steps.ID.outputs.text }}`).
- `stepId.output` (bare, full-string match only) — legacy alias that resolves to `${{ steps.stepId.outputs.text }}`.

Change the `outputs` map type from `HashMap<String, String>` to `HashMap<String, HashMap<String, String>>`. Action steps populate `{"text": "..."}`; genie steps populate `{"text": "...", "<k>": "..."}` for each declared field in v1 `output` (when `output.type: json`).

**Context:** Today's `resolve_params` only matches when a parameter value `.ends_with(".output")` and only stores a single string per step. Genies with structured output need multi-field access. GitHub Actions-style `${{ }}` is familiar to authors and is already called out in ADR-4 of the parent plan (which said "Dropped: ${{ }} expressions") — we selectively re-introduce the minimum needed subset. No arithmetic, no conditionals in expressions for this plan.

**Consequences:** Expression parser is a ~80 LOC regex + resolver. Existing action-step tests that rely on `stepId.output` keep working via the alias. Frontend YAML lint (future) can preview unresolved refs.

### ADR-4: Approval is a synchronous in-runner wait — not a checkpoint/resume

**Decision:** When a step's effective `approval` resolves to `ask`, the runner emits `workflow:approval-request` with `{ executionId, stepId, summary, preview }` and awaits a `tokio::sync::oneshot` receiver. The frontend opens a dialog, user decides, frontend calls a new `respond_workflow_approval(execution_id, step_id, approved)` command, the command sends on the oneshot sender. Timeout: the shorter of step `limits.timeout` (if set) or 10 minutes.

**Context:** Approval was planned in WI-5.5 of the parent plan but not implemented. A checkpoint-resume model (persist state, shut down runner, restart on response) is strictly more general but requires serializable state and workspace root re-validation. For a single-window desktop app, an in-process wait is simpler and equally safe: the user can't "approve later" across an app restart anyway (workflow is transient).

**Consequences:** Approval has one outstanding request per execution at a time (sequential runner matches this). Timeout becomes a failure mode; tests must cover it. Adds `approval_senders: Mutex<HashMap<String, oneshot::Sender<bool>>>` to `WorkflowRunnerState`. Approval applies to genie steps specifically in this plan; `action/save-file` approval is layered on top once the event pair is in place (stretch goal, not a blocker).

### ADR-5: Output type support — `text` and `json` only; `file` / `files` deferred

**Decision:** Genie v1 `output.type` values handled in this plan:

- `text` — return the raw AI response as `{"text": response}`.
- `json` — parse response as JSON; if `output.schema` is present, validate shape (keys/types); populate outputs map with each top-level field. Schema validation is minimal (keys exist, types match) — no JSON Schema library.

Deferred (returns "unsupported output type" error from runner): `file`, `files`, `pipe`.

**Context:** File-output genies need workspace-relative path validation, snapshot integration, and a sandboxed write surface — all achievable but each adds its own failure mode. Shipping `text` + `json` covers 95% of "transfer genie commands to workflows" cases without blocking on file I/O semantics.

**Consequences:** A v1 genie declaring `output.type: file` fails fast at step execution with a clear error. The sample workflow shipped in WI-6.1 exercises the `text` path (bundled genies are v0 per D11). JSON-output tests live alongside WI-2.2 using synthetic v1 genie fixtures.

### ADR-6: Per-step `model` / `approval` / `limits` — step wins over genie default wins over workflow default

**Decision:** Resolution order for each field when executing a genie step:

| Field | Precedence (highest first) |
|---|---|
| `model` | `step.model` → `genie.metadata.model` → `workflow.defaults.model` → provider default |
| `approval` | `step.approval` → `genie.metadata.approval` → `workflow.defaults.approval` → `auto` |
| `limits.timeout` | `step.limits.timeout` → `workflow.defaults.limits.timeout` → 300s (AI CLI default) |
| `limits.max_tokens` | `step.limits.max_tokens` → `workflow.defaults.limits.max_tokens` → provider default. **REST providers only.** CLI steps with `max_tokens` set emit a single warning per workflow run (not per step) and proceed unconstrained. |
| `limits.max_cost` | **Out of scope for this plan** — see D9. Accepted in YAML for forward compatibility but not surfaced in UI and not enforced. |

**Context:** `RawStep` already has `model`, `approval`, `limits` fields. `WorkflowDefaults` in the TS types exists but Rust `RawWorkflow` only reads `env` and `steps` from the YAML. We need to add `defaults` parsing on the Rust side.

**Consequences:** New `RawWorkflow.defaults` serde field. Resolution logic centralized in a new `step_config.rs` module. `max_cost` is silently ignored; the field is not mentioned in the user-facing guide so authors are not misled into thinking it is a guardrail.
