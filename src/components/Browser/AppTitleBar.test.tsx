import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppTitleBar } from "./AppTitleBar";
import { WindowContext } from "@/contexts/WindowContext";
import { useTabStore } from "@/stores/tabStore";

vi.mock("@/components/TitleBar", () => ({
  TitleBar: ({ browserChrome }: { browserChrome?: React.ReactNode }) => (
    <div data-testid="titlebar">{browserChrome}</div>
  ),
}));

function renderInWindow(isDocumentWindow = true) {
  return render(
    <WindowContext.Provider value={{ windowLabel: "main", isDocumentWindow }}>
      <AppTitleBar />
    </WindowContext.Provider>,
  );
}

describe("AppTitleBar", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  });

  it("renders the title bar without chrome when the browser workspace is inactive", () => {
    useTabStore.getState().createTab("main", "/docs/a.md");
    renderInWindow();
    expect(screen.getByTestId("titlebar")).toBeEmptyDOMElement();
  });

  it("injects the titlebar browser chrome when a browser page is the active tab", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    renderInWindow();
    const chrome = screen.getByTestId("titlebar").firstElementChild;
    expect(chrome).toHaveClass("browser-chrome--titlebar");
    expect(screen.getByRole("tab", { name: /One/ })).toHaveAttribute("aria-selected", "true");
  });

  it("renders no chrome outside a document window, even with a browser page", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    renderInWindow(false);
    expect(screen.getByTestId("titlebar")).toBeEmptyDOMElement();
  });
});
