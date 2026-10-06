/**
 * Purpose: The `with:` section of the step form — key/value rows the user can
 *   add, edit or remove, each producing a typed IRPatch, plus the
 *   action-metadata helpers around them. Renders nothing for a step that has
 *   neither `uses:` nor any `with:` key.
 *
 * Key decisions:
 *   - Rows hold local state and commit on blur through the pure plans in
 *     withRowPlans.ts (see `useStepWithRows`).
 *   - Key suggestions, required-input warnings and default placeholders come
 *     from the action's metadata (`useActionMetadata`, setting-gated); a
 *     failed fetch falls back to free-form rows.
 *   - Mounted unconditionally by StepForm so the row state lives as long as
 *     the form does; the empty case is an early return here, not a
 *     conditional mount there.
 *
 * @coordinates-with StepForm.tsx — the form this is a section of
 * @coordinates-with useStepWithRows.ts — row state, commits and suggestions
 * @module components/Editor/WorkflowEditor/StepWithSection
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { StepIR } from "@/lib/ghaWorkflow/types";
import { useStepWithRows } from "./useStepWithRows";

interface StepWithSectionProps {
  jobId: string;
  stepIndex: number;
  step: StepIR;
  /** The PRE-EDIT step a row compares itself against; see StepForm. */
  baseline: StepIR;
}

export function StepWithSection({
  jobId,
  stepIndex,
  step,
  baseline,
}: StepWithSectionProps): ReactElement | null {
  const { t } = useTranslation("workflowEditor");
  const {
    withRows, metadataResult, inputs, setKeys, missingRequired, datalistId, knownInputKeys,
    addSuggestedKey, updateRow, commitWithRow, removeRow, addRow,
  } = useStepWithRows({ jobId, stepIndex, step, baseline });

  if (!step.uses && withRows.length === 0) return null;

  return (
    <div className="workflow-form__field">
      <span className="workflow-form__label">
        {t("form.step.with.label")}
      </span>
      {metadataResult.state === "loading" && (
        <span className="workflow-form__metadata-loading">
          {t("panel.metadata.fetching")}
        </span>
      )}
      {metadataResult.state === "unavailable" && (
        <span className="workflow-form__metadata-loading">
          {t("panel.metadata.unavailable")}
        </span>
      )}
      <div className="workflow-form__with-rows">
        {withRows.map((row, idx) => {
          const schema = inputs?.[row.key];
          return (
            <div key={idx} className="workflow-form__with-row-group">
              <div className="workflow-form__with-row">
                <input
                  className="vm-input vm-input--field vm-input--mono workflow-form__input"
                  type="text"
                  value={row.key}
                  placeholder={t("form.step.with.keyPlaceholder")}
                  list={knownInputKeys.length > 0 ? datalistId : undefined}
                  aria-describedby={
                    knownInputKeys.length > 0
                      ? `${datalistId}-help`
                      : undefined
                  }
                  aria-invalid={row.duplicateKey || undefined}
                  onChange={(e) => updateRow(idx, { key: e.target.value })}
                  onBlur={() => commitWithRow(idx)}
                />
                <input
                  className="vm-input vm-input--field vm-input--mono workflow-form__input"
                  type="text"
                  value={row.value}
                  placeholder={
                    schema?.default ?? t("form.step.with.valuePlaceholder")
                  }
                  onChange={(e) => updateRow(idx, { value: e.target.value })}
                  onBlur={() => commitWithRow(idx)}
                />
                <button
                  type="button"
                  className="workflow-form__with-remove"
                  aria-label={t("form.step.with.removeRow")}
                  onClick={() => removeRow(idx)}
                >
                  ×
                </button>
              </div>
              {row.duplicateKey && (
                <span className="workflow-form__with-error" role="alert">
                  {t("form.step.with.duplicateKey")}
                </span>
              )}
              {schema?.description && (
                <span className="workflow-form__metadata-desc">
                  {schema.description}
                </span>
              )}
            </div>
          );
        })}
        {missingRequired.length > 0 && (
          <div className="workflow-form__missing-required">
            <span className="workflow-form__label">
              {t("form.step.with.missingRequired")}
            </span>
            {missingRequired.map(([key, schema]) => (
              <button
                key={key}
                type="button"
                className="workflow-form__missing-required-key"
                onClick={() => addSuggestedKey(key)}
                title={schema.description ?? ""}
              >
                <code>{key}</code>
                <span aria-label="required">*</span>
              </button>
            ))}
          </div>
        )}
        {knownInputKeys.length > 0 && (
          <details
            id={`${datalistId}-help`}
            className="workflow-form__known-inputs"
          >
            <summary className="workflow-form__known-inputs-summary">
              {t("form.step.with.knownInputs", {
                defaultValue: "Available inputs ({{count}})",
                count: knownInputKeys.length,
              })}
            </summary>
            <div className="workflow-form__known-inputs-list">
              {Object.entries(inputs!).map(([key, schema]) => {
                const used = setKeys.has(key);
                return (
                  <div
                    key={key}
                    className="workflow-form__known-input-row"
                  >
                    <button
                      type="button"
                      className="workflow-form__known-input"
                      data-used={used}
                      disabled={used}
                      onClick={() => addSuggestedKey(key)}
                      aria-label={
                        schema.description
                          ? `${key} — ${schema.description}`
                          : key
                      }
                      title={schema.description ?? ""}
                    >
                      <code>{key}</code>
                      {schema.required && (
                        <span
                          className="workflow-form__known-input-required"
                          aria-label={t("form.step.with.required", {
                            defaultValue: "required",
                          })}
                        >
                          *
                        </span>
                      )}
                    </button>
                    {schema.description && (
                      <span
                        className="workflow-form__known-input-desc"
                        id={`${datalistId}-${key}-desc`}
                      >
                        {schema.description}
                        {schema.default !== undefined && (
                          <em className="workflow-form__known-input-default">
                            {" "}
                            {t("form.step.with.defaultValue", {
                              defaultValue: "(default: {{value}})",
                              value: schema.default,
                            })}
                          </em>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        )}
        {knownInputKeys.length > 0 && (
          <datalist id={datalistId}>
            {knownInputKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        )}
        <button
          type="button"
          className="workflow-form__with-add"
          onClick={addRow}
        >
          + {t("form.step.with.addRow")}
        </button>
      </div>
    </div>
  );
}
