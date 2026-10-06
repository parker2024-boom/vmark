import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { BrowserChrome } from "./BrowserChrome";
import { useTabStore } from "@/stores/tabStore";
import { bootstrapFormats } from "@/lib/formats";

vi.mock("@/contexts/WindowContext", () => ({ useWindowLabel: () => "main" }));
vi.mock("@/services/tabs/tabOperations", () => ({
  closeTabWithDirtyCheck: vi.fn(() => Promise.resolve(true)),
}));

/** The real omnibox's address bar. */
const addressBar = () => screen.getByRole("textbox", { name: "Address bar" });
const queryAddressBar = () => screen.queryByRole("textbox", { name: "Address bar" });

/**
 * Assert which page the mounted omnibox drives. Its Reload re-navigates the
 * page it addresses, so the target is read off the navigation command at the
 * Tauri boundary (`invoke`, mocked in `src/test/setup.ts`).
 */
function expectOmniboxToNavigate(pageId: string, host: string): void {
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(invoke).toHaveBeenCalledWith("browser_navigate", {
    tabId: pageId,
    url: expect.stringContaining(host),
  });
}

describe("BrowserChrome", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: {},
      activeTabId: {},
      untitledCounter: 0,
    });
  });

  it("renders webpage tabs and the address bar in the workspace", () => {
    const first = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    useTabStore.getState().createBrowserPage("main", "https://two.example", "Two");

    render(<BrowserChrome />);

    expect(screen.getByRole("tablist", { name: "Webpages" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /One/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /Two/ })).toHaveAttribute("aria-selected", "true");
    // Off macOS this placement IS the browser's only chrome, so it carries the
    // omnibox too — the title-bar strip it used to live in is not rendered there
    // (#1296). The two placements are mutually exclusive by platform, so this
    // cannot double up with the title bar's copy.
    expect(addressBar()).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: /One/ }), { key: "Enter" });
    expect(useTabStore.getState().activeTabId.main).toBe(first);

    fireEvent.click(screen.getByRole("tab", { name: /One/ }));
    expect(useTabStore.getState().activeTabId.main).toBe(first);
  });

  it("addresses the window's active page when the caller names none", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    const two = useTabStore.getState().createBrowserPage("main", "https://two.example", "Two");

    render(<BrowserChrome />);

    expectOmniboxToNavigate(two, "two.example");
  });

  it("addresses the page it is GIVEN — the pane's, not the window's (split view)", () => {
    const one = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    useTabStore.getState().createBrowserPage("main", "https://two.example", "Two"); // window-active

    render(<BrowserChrome activePageId={one} />);

    // A pane showing page One must not hand its address bar to page Two: the
    // omnibox drives navigation, so aiming it elsewhere would navigate a page
    // the user cannot see.
    expectOmniboxToNavigate(one, "one.example");
  });

  it("renders nothing when the window has no browser page at all", () => {
    render(<BrowserChrome />);

    expect(screen.queryByRole("tablist", { name: "Webpages" })).not.toBeInTheDocument();
    expect(queryAddressBar()).not.toBeInTheDocument();
  });

  it("renders nothing for an id that was never a page", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");

    render(<BrowserChrome activePageId="tab-does-not-exist" />);

    // Binding the omnibox to a dead id would point navigation at nothing while
    // the chrome looked normal — no tab selected, submit silently misfiring.
    expect(queryAddressBar()).not.toBeInTheDocument();
  });

  it("drops the chrome when the page it addresses is CLOSED", () => {
    // The reactive path, not a synthetic bad id: the page exists, the chrome
    // renders, then the page goes away underneath it. This is how a stale id
    // actually arises in the app.
    const one = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    useTabStore.getState().createBrowserPage("main", "https://two.example", "Two");

    const { rerender } = render(<BrowserChrome activePageId={one} />);
    expectOmniboxToNavigate(one, "one.example");

    useTabStore.getState().closeTab("main", one);
    rerender(<BrowserChrome activePageId={one} />);

    expect(queryAddressBar()).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Webpages" })).not.toBeInTheDocument();
  });

  it("renders nothing for a DOCUMENT tab id", () => {
    // A document tab derives its format from the registry the app bootstraps
    // at startup; without it the tab is built in a state the app never makes.
    bootstrapFormats({ dataFormats: false, diagrams: false, htmlPreview: false, codeViewers: false });
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    const doc = useTabStore.getState().createTab("main");

    render(<BrowserChrome activePageId={doc} />);

    expect(queryAddressBar()).not.toBeInTheDocument();
  });

  it("the close button is a sibling of its tab, so Enter on it never reaches the tab (#163)", () => {
    const first = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    useTabStore.getState().createBrowserPage("main", "https://two.example", "Two"); // Two is active
    render(<BrowserChrome />);

    const oneTab = screen.getByRole("tab", { name: /One/ });
    const closeBtn = screen.getByRole("button", { name: "Close One" });
    // Not nested: a keydown on the close control has no tab above it to bubble into.
    expect(oneTab.contains(closeBtn)).toBe(false);
    fireEvent.keyDown(closeBtn, { key: "Enter" });
    expect(useTabStore.getState().activeTabId.main).not.toBe(first);
  });

  it("creates a fresh webpage when the top plus button is clicked", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    render(<BrowserChrome />);

    fireEvent.click(screen.getByRole("button", { name: "New webpage" }));

    expect(useTabStore.getState().tabs.main).toHaveLength(2);
    expect(useTabStore.getState().activeTabId.main).toBe(useTabStore.getState().tabs.main?.[1].id);
  });

  it("renders webpage tabs and navigation together in the title bar", () => {
    const one = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    render(<BrowserChrome placement="titlebar" />);

    expect(screen.getByRole("tablist", { name: "Webpages" })).toBeInTheDocument();
    expect(document.querySelector(".browser-titlebar-navigation")).toBeInTheDocument();
    // The omnibox sits IN the navigation group and drives the page.
    expect(addressBar().closest(".browser-titlebar-navigation")).toBeInTheDocument();
    expectOmniboxToNavigate(one, "one.example");
    expect(document.querySelector(".browser-titlebar-drag-space")).toHaveAttribute(
      "data-tauri-drag-region",
    );
  });

  it("uses the webpage title instead of its URL for the tab label", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    useTabStore.getState().createBrowserPage("main", "https://two.example");
    render(<BrowserChrome />);

    expect(screen.getByRole("tab", { name: "One" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "New webpage" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /two\.example/ })).not.toBeInTheDocument();
  });
});

// WI-NB5.1 — the "AI is controlling" indicator + chrome-interaction reclaim.
// The chrome is the one place React CAN see human input (the page itself is a
// native sibling view), so any interaction here while the AI holds the lease is
// a takeover.
describe("AI lease indicator (WI-NB5.1)", () => {
  async function leaseService() {
    const [{ browserLease }, { resetBrowserLeaseStore }] = await Promise.all([
      import("@/services/browser/lease"),
      import("@/stores/browserLeaseStore"),
    ]);
    return { browserLease, resetBrowserLeaseStore };
  }

  beforeEach(async () => {
    (await leaseService()).resetBrowserLeaseStore();
  });

  it("shows a takeover button while the AI holds the active page's lease", async () => {
    const { browserLease } = await leaseService();
    const id = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    browserLease.acquireForAi(id);

    render(<BrowserChrome />);
    const takeover = screen.getByRole("button", { name: /AI is controlling/i });
    expect(takeover).toBeInTheDocument();

    fireEvent.click(takeover);
    expect(browserLease.currentHolder(id)).toBe("human");
  });

  it("renders no indicator when nobody holds a lease", () => {
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    render(<BrowserChrome />);
    expect(screen.queryByRole("button", { name: /AI is controlling/i })).toBeNull();
  });

  it("any chrome interaction reclaims an AI-held lease (capture phase)", async () => {
    const { browserLease } = await leaseService();
    const id = useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    browserLease.acquireForAi(id);

    render(<BrowserChrome />);
    fireEvent.mouseDown(addressBar());
    expect(browserLease.currentHolder(id)).toBe("human");
  });
});
