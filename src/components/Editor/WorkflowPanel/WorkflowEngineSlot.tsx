/**
 * WorkflowEngineSlot — the one place the workflow ENGINE reaches the editor UI.
 *
 * Purpose: mount the Run/Cancel side panel only while
 * `advanced.workflowEngine` is on. Split out of `markdownSurface.tsx`
 * so the gate is a component with a test rather than an inline `&&` inside a
 * surface that needs Tiptap to render — "the affordance is hidden" was until
 * now the ONLY thing stopping the engine, because the Rust commands ignored
 * the flag entirely (`workflow::guards` closes that half).
 *
 * The viewer flag deliberately does NOT appear here: the GitHub Actions
 * surface is the yaml adapter's `gha-workflow` schema renderer, which ships
 * always-on and is gated by neither flag.
 *
 * The yaml adapter reaches the same Run/Cancel panel on its own path — the
 * `vmark-workflow` schema renderer (`yamlEngineRenderer.tsx`), which applies
 * the same flag — because a `.yml` file never mounts the markdown surface.
 *
 * @coordinates-with lib/formats/adapters/markdownSurface.tsx — the sole mount
 * @coordinates-with services/featureFlags/workflowFeatureFlag.ts — the flags
 * @module components/Editor/WorkflowPanel/WorkflowEngineSlot
 */
import { lazy, Suspense } from "react";
import { useSettingsStore } from "@/stores/settingsStore";

/* v8 ignore next 3 -- @preserve React.lazy wrapper; no logic to test */
const WorkflowSidePanel = lazy(() =>
  import("./WorkflowSidePanel").then((m) => ({
    default: m.WorkflowSidePanel,
  })),
);

/** `tabId` is the surface's own document: the panel runs THAT tab (WI-LX2.2). */
export function WorkflowEngineSlot({ tabId }: { tabId: string | null }) {
  const engineEnabled = useSettingsStore((s) => s.advanced.workflowEngine);
  if (!engineEnabled) return null;
  return (
    <Suspense fallback={null}>
      <WorkflowSidePanel tabId={tabId} />
    </Suspense>
  );
}
