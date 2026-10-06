/**
 * Audit 20260804-F4 — the KB graph chunk fails inside the panel, not at the root.
 *
 * The graph is ~3.2 MB of xyflow + dagre behind `React.lazy`, and the panel
 * wrapped it in a bare `<Suspense>`. Suspense handles the PENDING half only:
 * a rejected chunk propagated past the panel to App's root boundary, so a
 * failed fetch of an optional side panel blanked the entire window. And the
 * lazy object was module-level, so its memoized rejection outlived every
 * remount — there was no recovery short of restarting.
 *
 * Nothing is mocked. The chunk fetch is the boundary, and a module registry
 * cannot be made to re-fail a module that resolved once, so the running view's
 * real boundary and retry are driven through its `loadGraph` parameter. The
 * load of the REAL chunk through the default loader is covered by
 * `KnowledgeBasePanel.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgeBaseRunning, type KbGraphLoader } from "./KnowledgeBasePanelViews";

function Graph() {
  return <div data-testid="kb-graph" />;
}

/** A chunk loader that rejects `failures` times, then resolves. */
function flakyChunk(failures: number) {
  const state = { failures, loads: 0 };
  const load: KbGraphLoader = async () => {
    state.loads += 1;
    if (state.failures > 0) {
      state.failures -= 1;
      throw new Error("Failed to fetch dynamically imported module");
    }
    return { default: Graph };
  };
  return { state, load };
}

function renderRunning(load: KbGraphLoader) {
  render(
    <KnowledgeBaseRunning
      url="http://127.0.0.1:4321"
      iframeUrl={null}
      viewMode="graph"
      onStop={vi.fn()}
      onOpenInBrowser={vi.fn()}
      onPreviewSlides={vi.fn()}
      onExportSlides={vi.fn()}
      loadGraph={load}
    />,
  );
}

describe("KB graph chunk failure stays inside the panel", () => {
  it("renders the graph error in place, with the panel chrome intact", async () => {
    renderRunning(flakyChunk(1).load);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't load the graph/i);
    expect(screen.queryByTestId("kb-graph")).toBeNull();
    // Containment, stated as an assertion: the surrounding panel — the thing a
    // root-boundary escape would have taken with it — is still on screen.
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open in browser/i })).toBeTruthy();
  });

  it("loads the graph when the user retries", async () => {
    const chunk = flakyChunk(1);
    renderRunning(chunk.load);
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));

    expect(await screen.findByTestId("kb-graph")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // The retry loaded again rather than replaying a memoized rejection.
    expect(chunk.state.loads).toBe(2);
  });

  it("keeps offering retry while the chunk keeps failing", async () => {
    const chunk = flakyChunk(2);
    renderRunning(chunk.load);
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await vi.waitFor(() => expect(chunk.state.loads).toBe(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load the graph/i);

    await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByTestId("kb-graph")).toBeTruthy();
    expect(chunk.state.loads).toBe(3);
  });

  it("renders the graph normally when the chunk loads", async () => {
    const chunk = flakyChunk(0);
    renderRunning(chunk.load);
    expect(await screen.findByTestId("kb-graph")).toBeTruthy();
    expect(chunk.state.loads).toBe(1);
  });
});
