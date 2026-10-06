/**
 * Purpose: Edit form for one step inside a job. Handles both `uses:`
 *   and `run:` step kinds. The component owns layout; the logic lives in
 *   `useStepNavigation` (back/prev/next and Alt+Arrow) and `useStepFields`
 *   (scalar fields and the expand editor). The `with:` block is its own
 *   component, `StepWithSection`.
 *
 * Origin: GitHub Actions workflow viewer plan (retired) §6
 *   Phase 7.
 *
 * Key decisions:
 *   - `uses:` is read-only in this form (Phase 7). Changing the action
 *     reference is a structural edit better expressed in source until
 *     a dedicated action picker exists.
 *
 * @coordinates-with src/stores/workflowStore.ts — IRPatch sink
 * @coordinates-with StepWithSection.tsx — the `with:` rows
 * @module components/Editor/WorkflowEditor/StepForm
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, ArrowUp } from "lucide-react";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { ExpressionEditor } from "./ExpressionEditor";
import { useStepFields } from "./useStepFields";
import { useStepNavigation } from "./useStepNavigation";
import { StepWithSection } from "./StepWithSection";
import "./workflow-editor.css";

interface StepFormProps {
  jobId: string;
  stepIndex: number;
  step: StepIR;
  /** The PRE-EDIT step — what a field (and a `with:` row) compares itself
   *  against to decide the user has reverted it. `step` is the preview and
   *  already carries this step's queued edits, so comparing against it
   *  cancelled the edit just committed. Defaults to `step`,
   *  which is only the same thing while nothing is queued. */
  baseline?: StepIR | undefined;
  /** Total number of steps in this job — used to render N of M.
   *  Optional for unit tests that render the form in isolation; production
   *  callers (WorkflowEditorPanel) always provide it. Defaults to
   *  `stepIndex + 1` so the position label degrades to "Step N of N". */
  stepCount?: number;
  /** Step id to navigate to with Prev. null/undefined disables the button. */
  prevStepId?: string | null;
  /** Step id to navigate to with Next. null/undefined disables the button. */
  nextStepId?: string | null;
}

export function StepForm({
  jobId,
  stepIndex,
  step,
  baseline = step,
  stepCount,
  prevStepId = null,
  nextStepId = null,
}: StepFormProps): ReactElement {
  const totalSteps = stepCount ?? stepIndex + 1;
  const { t } = useTranslation("workflowEditor");

  const { goToStep, backToJob } = useStepNavigation(jobId, prevStepId, nextStepId);
  const {
    name, setName, run, setRun, workingDir, setWorkingDir, ifCond, setIfCond,
    expand, setExpand, commitField, handleExpandSave,
  } = useStepFields({ jobId, stepIndex, step, baseline });

  return (
    <form className="workflow-form" onSubmit={(e) => e.preventDefault()}>
      <header className="workflow-form__header workflow-form__header--step">
        <button
          type="button" data-step-nav="back-to-job"
          className="vm-icon-btn vm-icon-btn--sm workflow-form__nav-btn"
          onClick={backToJob}
          aria-label={t("form.step.nav.backToJob", {
            defaultValue: "Back to job",
          })}
          title={t("form.step.nav.backToJob", { defaultValue: "Back to job" })}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button" data-step-nav="prev"
          className="vm-icon-btn vm-icon-btn--sm workflow-form__nav-btn"
          onClick={() => goToStep(prevStepId)}
          disabled={!prevStepId}
          aria-label={t("form.step.nav.prev", {
            defaultValue: "Previous step (Alt+Left)",
          })}
          title={t("form.step.nav.prev", {
            defaultValue: "Previous step (Alt+Left)",
          })}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="workflow-form__step-position">
          {t("form.step.nav.position", {
            defaultValue: "Step {{current}} of {{total}}",
            current: stepIndex + 1,
            total: totalSteps,
          })}
        </span>
        <button
          type="button" data-step-nav="next"
          className="vm-icon-btn vm-icon-btn--sm workflow-form__nav-btn"
          onClick={() => goToStep(nextStepId)}
          disabled={!nextStepId}
          aria-label={t("form.step.nav.next", {
            defaultValue: "Next step (Alt+Right)",
          })}
          title={t("form.step.nav.next", {
            defaultValue: "Next step (Alt+Right)",
          })}
        >
          <ChevronRight size={14} />
        </button>
        <code className="workflow-form__id" title={step.id}>
          {step.id}
        </code>
      </header>

      <label className="workflow-form__field">
        <span className="workflow-form__label">{t("form.step.name.label")}</span>
        <input
          className="vm-input vm-input--field workflow-form__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => commitField("name", name, baseline.name ?? "")}
        />
      </label>

      {step.uses && (
        <div className="workflow-form__field">
          <span className="workflow-form__label">{t("form.step.uses.label")}</span>
          <code className="workflow-form__id">{step.uses}</code>
        </div>
      )}

      {step.run !== undefined && (
        <label className="workflow-form__field">
          <span className="workflow-form__label">{t("form.step.run.label")}</span>
          <textarea
            className="vm-input vm-input--field vm-input--mono workflow-form__input"
            rows={3}
            value={run}
            onChange={(e) => setRun(e.target.value)}
            onBlur={() => commitField("run", run, baseline.run ?? "")}
          />
          <button
            type="button"
            className="workflow-form__expand-btn"
            onClick={() => setExpand({ field: "run", value: run })}
          >
            {t("expression.expand.run")}
          </button>
        </label>
      )}

      <label className="workflow-form__field">
        <span className="workflow-form__label">
          {t("form.step.workingDirectory.label")}
        </span>
        <input
          className="vm-input vm-input--field vm-input--mono workflow-form__input"
          type="text"
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          onBlur={() =>
            commitField(
              "working-directory",
              workingDir,
              baseline.workingDirectory ?? "",
            )
          }
        />
      </label>

      <label className="workflow-form__field">
        <span className="workflow-form__label">{t("form.step.if.label")}</span>
        <textarea
          className="vm-input vm-input--field vm-input--mono workflow-form__input"
          rows={2}
          value={ifCond}
          onChange={(e) => setIfCond(e.target.value)}
          onBlur={() => commitField("if", ifCond, baseline.if ?? "")}
        />
        <button
          type="button"
          className="workflow-form__expand-btn"
          onClick={() => setExpand({ field: "if", value: ifCond })}
        >
          {t("expression.expand.if")}
        </button>
      </label>

      <StepWithSection jobId={jobId} stepIndex={stepIndex} step={step} baseline={baseline} />
      {expand && (
        <ExpressionEditor
          initialValue={expand.value}
          language={expand.field === "if" ? "yaml" : "plain"}
          title={t(
            expand.field === "if"
              ? "expression.title.if"
              : "expression.title.run",
          )}
          onSave={handleExpandSave}
          onCancel={() => setExpand(null)}
        />
      )}
    </form>
  );
}
