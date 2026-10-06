// WI-UI4.5 — axe coverage for the terminal tab bar: session tabs (live, dead,
// background-activity) and the action buttons. `focus-order-semantics` is
// enabled; `color-contrast` stays DISABLED — jsdom computes no layout, so the
// rule is unreliable here (house-standard reason; real contrast is measured
// by `pnpm lint:theme-contrast` from the catalog).
import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@/test/axeMatchers";
import { axe } from "vitest-axe";
import { TerminalTabBar } from "./TerminalTabBar";
import { resetTerminalSessionStore, useTerminalStore } from "@/stores/terminalStore";

const AXE_OPTS = {
  rules: {
    "color-contrast": { enabled: false },
    "focus-order-semantics": { enabled: true },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetTerminalSessionStore();
});

describe("TerminalTabBar a11y (WI-UI4.5)", () => {
  it("live + dead + background-activity states pass axe", async () => {
    useTerminalStore.getState().terminalCreateSession();
    useTerminalStore.getState().terminalCreateSession();
    const st = useTerminalStore.getState();
    useTerminalStore.setState({
      sessions: st.sessions.map((x, i) =>
        i === 0 ? { ...x, isAlive: false } : { ...x, hasActivity: true },
      ),
    });
    const { container } = render(
      <TerminalTabBar onClose={vi.fn()} onRestart={vi.fn()} position="bottom" />,
    );
    expect(await axe(container, AXE_OPTS)).toHaveNoViolations();
  });

  it("the background-activity state has a text channel, not just the dot", () => {
    useTerminalStore.getState().terminalCreateSession();
    useTerminalStore.getState().terminalCreateSession();
    const st = useTerminalStore.getState();
    useTerminalStore.setState({
      sessions: st.sessions.map((x, i) => (i === 1 ? { ...x, hasActivity: true } : x)),
      activeSessionId: st.sessions[0].id,
    });
    const { container } = render(
      <TerminalTabBar onClose={vi.fn()} onRestart={vi.fn()} position="bottom" />,
    );
    const activity = container.querySelector(".terminal-tab-activity .sr-only");
    expect(activity?.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});
