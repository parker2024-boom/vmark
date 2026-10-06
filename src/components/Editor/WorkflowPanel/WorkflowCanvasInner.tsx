/**
 * Purpose: The xyflow + dagre subtree of the workflow canvas. Split out
 *   so its 90 kB of dependencies (xyflow + xyflow CSS, both pulled
 *   transitively) can be lazy-loaded by `WorkflowCanvas`. Without this
 *   split the eager App bundle absorbs xyflow on every cold start, even
 *   for users who never open a workflow.
 *
 * Origin: GitHub Actions workflow viewer plan (retired)
 *   Phase 9 audit follow-up — judgment-agent finding.
 *
 * Key decisions:
 *   - The inner component is the entire xyflow surface. The outer
 *     WorkflowCanvas keeps the ReactFlowProvider + Suspense boundary so
 *     its consumer (GhaWorkflowWorkbench) keeps its existing import shape.
 *   - Module-scope NODE_TYPES + PRO_OPTIONS keep React 19's effect
 *     unmount path from feeding xyflow's internal setState a new
 *     identity on every render (the "Maximum update depth exceeded"
 *     loop documented in the size-limit comment for the eager App
 *     entry). This file holds those constants now.
 *   - The control strip carries a top-down / left-to-right toggle
 *     (WI-LX2.4) — the store's `setLayoutDirection` had no caller, so the
 *     canvas was always top-down. Long `needs:` chains read better across
 *     a wide pane (preview-only mode). Each node gets the handle sides for
 *     the direction, so its edges attach where the layout put its
 *     neighbours.
 *
 * @coordinates-with src/components/Editor/WorkflowPanel/WorkflowCanvas.tsx
 *   — lazy-loads this module.
 * @module components/Editor/WorkflowPanel/WorkflowCanvasInner
 */

import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowRight } from "lucide-react";
import {
  Background,
  ControlButton,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowIR } from "@/lib/ghaWorkflow/types";
import { toGraph, type JobNodeData } from "@/lib/ghaWorkflow/render/toGraph";
import { applyLayout, type LayoutDirection } from "@/lib/ghaWorkflow/render/layout";
import { useWorkflowStore } from "@/stores/workflowStore";
import { JobNode } from "./JobNode";

// With JobNode now typed as
// `NodeProps<Node<JobNodeData>>` instead of `Node<JobNodeData>`, the
// node-types registry no longer needs an `as` cast. Drift in
// JobNodeData or the node-type contract is now a compile error.
const NODE_TYPES: NodeTypes = { job: JobNode };
const PRO_OPTIONS = { hideAttribution: true } as const;
/** Lucide draws strokes; xyflow's control CSS fills svgs, which would fill the arrowheads. */
const ICON_STYLE = { fill: "none" } as const;

/** Which sides a node's edges attach to, per layout direction. */
const HANDLE_SIDES: Record<LayoutDirection, { targetPosition: Position; sourcePosition: Position }> = {
  TD: { targetPosition: Position.Top, sourcePosition: Position.Bottom },
  BT: { targetPosition: Position.Bottom, sourcePosition: Position.Top },
  LR: { targetPosition: Position.Left, sourcePosition: Position.Right },
  RL: { targetPosition: Position.Right, sourcePosition: Position.Left },
};

interface WorkflowCanvasInnerProps {
  workflow: WorkflowIR;
}

function CanvasInner({ workflow }: WorkflowCanvasInnerProps): ReactElement {
  const { t } = useTranslation("workflowEditor");
  const direction = useWorkflowStore((s) => s.view.layoutDirection);

  const { nodes, edges } = useMemo(() => {
    const graph = toGraph(workflow);
    const laid = applyLayout(graph.nodes, graph.edges, { direction });
    const sides = HANDLE_SIDES[direction];
    return { nodes: laid.nodes.map((n) => ({ ...n, ...sides })), edges: laid.edges };
  }, [workflow, direction]);

  // Refit after a direction change; the first layout is fitted by the prop.
  // Deferred like WorkflowPreview's refit, so the moved nodes have committed.
  const { fitView } = useReactFlow();
  const fittedDirection = useRef(direction);
  useEffect(() => {
    if (fittedDirection.current === direction) return;
    fittedDirection.current = direction;
    const timer = setTimeout(() => void fitView({ padding: 0.1 }), 50);
    return () => clearTimeout(timer);
  }, [direction, fitView]);

  const onPaneClick = useCallback(() => {
    useWorkflowStore.getState().clearSelection();
  }, []);

  const horizontal = direction === "LR";
  const toggleLabel = horizontal ? t("panel.layout.topToBottom") : t("panel.layout.leftToRight");
  const onToggleLayout = useCallback(() => {
    const current = useWorkflowStore.getState().view.layoutDirection;
    useWorkflowStore.getState().setLayoutDirection(current === "LR" ? "TD" : "LR");
  }, []);

  return (
    <ReactFlow<Node<JobNodeData>>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={PRO_OPTIONS}
      onPaneClick={onPaneClick}
    >
      <Background />
      <Controls>
        <ControlButton onClick={onToggleLayout} aria-label={toggleLabel} title={toggleLabel}>
          {horizontal ? (
            <ArrowDown size={14} style={ICON_STYLE} />
          ) : (
            <ArrowRight size={14} style={ICON_STYLE} />
          )}
        </ControlButton>
      </Controls>
    </ReactFlow>
  );
}

export function WorkflowCanvasInner(
  props: WorkflowCanvasInnerProps,
): ReactElement {
  // ReactFlowProvider sits inside the lazy chunk too — keeping it in
  // the eager outer file would defeat the bundle-split goal because
  // it pulls all of xyflow with it.
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
