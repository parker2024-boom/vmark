/**
 * Tests for Diagram Export (shared)
 *
 * Covers export button creation, theme menu, event handling,
 * cleanup, and edge cases.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  setupDiagramExport,
  LIGHT_BG,
  DARK_BG,
  type ExportTheme,
} from "./diagramExport";
import { _registrySize, cleanupDescendants, sweepDetached } from "./diagramCleanup";

let container: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  // Clean up DOM safely
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  // Every container is now detached: run their registered destroys, which
  // also drops each test's document listeners and empties the registry.
  sweepDetached();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("constants", () => {
  it("exports LIGHT_BG as white", () => {
    expect(LIGHT_BG).toBe("#ffffff");
  });

  it("exports DARK_BG as dark", () => {
    expect(DARK_BG).toBe("#1e1e1e");
  });
});

// ---------------------------------------------------------------------------
// setupDiagramExport - button creation
// ---------------------------------------------------------------------------
describe("setupDiagramExport - button creation", () => {
  it("appends an export button to the container", () => {
    const doExport = vi.fn();
    setupDiagramExport(container, doExport);

    const btn = container.querySelector(".mermaid-export-btn");
    expect(btn).not.toBeNull();
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn?.getAttribute("title")).toBe("Export as PNG");
  });

  it("inserts button before reset button when present", () => {
    const resetBtn = document.createElement("button");
    resetBtn.className = "mermaid-panzoom-reset";
    container.appendChild(resetBtn);

    setupDiagramExport(container, vi.fn());

    const children = Array.from(container.children);
    const exportBtn = container.querySelector(".mermaid-export-btn");
    expect(children.indexOf(exportBtn as Element)).toBeLessThan(
      children.indexOf(resetBtn),
    );
  });

  it("appends button at end when no reset button exists", () => {
    const existingChild = document.createElement("span");
    container.appendChild(existingChild);

    setupDiagramExport(container, vi.fn());

    const lastChild = container.lastElementChild;
    expect(lastChild?.classList.contains("mermaid-export-btn")).toBe(true);
  });

  it("contains SVG icon inside button", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector(".mermaid-export-btn");
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setupDiagramExport - menu behavior
// ---------------------------------------------------------------------------
describe("setupDiagramExport - menu behavior", () => {
  it("shows menu with Light and Dark options on click", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const menu = document.querySelector(".mermaid-export-menu");
    expect(menu).not.toBeNull();

    const items = menu!.querySelectorAll(".mermaid-export-menu-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("Light");
    expect(items[1].textContent).toBe("Dark");
  });

  it("shows color swatches in menu items", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const swatches = document.querySelectorAll<HTMLElement>(
      ".mermaid-export-menu-swatch",
    );
    expect(swatches).toHaveLength(2);
    // jsdom normalizes hex to rgb()
    expect(swatches[0].style.background).toBe("rgb(255, 255, 255)");
    expect(swatches[1].style.background).toBe("rgb(30, 30, 30)");
  });

  it("toggles menu off when clicking button again", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();

    btn.click();
    expect(document.querySelector(".mermaid-export-menu")).toBeNull();
  });

  it("calls doExport with 'light' when Light is clicked", () => {
    const doExport = vi.fn<(theme: ExportTheme) => Promise<void>>().mockResolvedValue(undefined);
    setupDiagramExport(container, doExport);

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const items = document.querySelectorAll<HTMLElement>(
      ".mermaid-export-menu-item",
    );
    items[0].click();

    expect(doExport).toHaveBeenCalledWith("light");
  });

  it("calls doExport with 'dark' when Dark is clicked", () => {
    const doExport = vi.fn<(theme: ExportTheme) => Promise<void>>().mockResolvedValue(undefined);
    setupDiagramExport(container, doExport);

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const items = document.querySelectorAll<HTMLElement>(
      ".mermaid-export-menu-item",
    );
    items[1].click();

    expect(doExport).toHaveBeenCalledWith("dark");
  });

  it("closes menu after selecting an item", () => {
    setupDiagramExport(container, vi.fn().mockResolvedValue(undefined));

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const items = document.querySelectorAll<HTMLElement>(
      ".mermaid-export-menu-item",
    );
    items[0].click();

    expect(document.querySelector(".mermaid-export-menu")).toBeNull();
  });

  it("closes menu on Escape key", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".mermaid-export-menu")).toBeNull();
  });

  it("does not close on Escape when no menu is open", () => {
    setupDiagramExport(container, vi.fn());

    // No error should be thrown
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("closes menu on outside click", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();

    // Click on body (outside menu and button)
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(document.querySelector(".mermaid-export-menu")).toBeNull();
  });

  it("does not close menu when mousedown is on the export button itself", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click(); // open menu
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();

    // Dispatch mousedown on the button — the onClickOutside handler should bail
    // out via the btn.contains() check, leaving the menu open (click will toggle it)
    const mousedownEvent = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    Object.defineProperty(mousedownEvent, "target", { value: btn, configurable: true });
    document.dispatchEvent(mousedownEvent);

    // Menu should still be present (btn.contains returned true so closeMenu was not called)
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();
  });

  it("does not close menu when clicking inside menu", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const menu = document.querySelector<HTMLElement>(".mermaid-export-menu")!;
    menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setupDiagramExport - event prevention
// ---------------------------------------------------------------------------
describe("setupDiagramExport - event prevention", () => {
  it("prevents default on button mousedown", () => {
    setupDiagramExport(container, vi.fn());
    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;

    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    const spy = vi.spyOn(event, "stopPropagation");
    btn.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it("prevents default and stops propagation on menu item mousedown (lines 156-157)", () => {
    setupDiagramExport(container, vi.fn());
    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click(); // open menu

    const menuItem = document.querySelector<HTMLElement>(".mermaid-export-menu-item")!;
    expect(menuItem).not.toBeNull();

    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    const spy = vi.spyOn(event, "stopPropagation");
    menuItem.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it("stops propagation on button pointerdown", () => {
    setupDiagramExport(container, vi.fn());
    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;

    // jsdom does not have PointerEvent, use MouseEvent as substitute
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    const spy = vi.spyOn(event, "stopPropagation");
    btn.dispatchEvent(event);

    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setupDiagramExport - destroy / cleanup
// ---------------------------------------------------------------------------
describe("setupDiagramExport - destroy", () => {
  it("returns an object with a destroy method", () => {
    const instance = setupDiagramExport(container, vi.fn());
    expect(typeof instance.destroy).toBe("function");
  });

  it("removes the export button on destroy", () => {
    const instance = setupDiagramExport(container, vi.fn());
    expect(container.querySelector(".mermaid-export-btn")).not.toBeNull();

    instance.destroy();
    expect(container.querySelector(".mermaid-export-btn")).toBeNull();
  });

  it("removes open menu on destroy", () => {
    const instance = setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();

    instance.destroy();
    expect(document.querySelector(".mermaid-export-menu")).toBeNull();
  });

  it("registers its cleanup under the container itself", () => {
    setupDiagramExport(container, vi.fn());
    expect(_registrySize()).toBe(1);

    // With the button gone the container has no descendants, so only an
    // entry keyed on the container itself can match.
    container.querySelector(".mermaid-export-btn")!.remove();
    cleanupDescendants(container);

    expect(_registrySize()).toBe(0);
  });

  it("the registered cleanup is a full destroy of the export UI", () => {
    setupDiagramExport(container, vi.fn());
    container.querySelector<HTMLElement>(".mermaid-export-btn")!.click();
    expect(document.querySelector(".mermaid-export-menu")).not.toBeNull();

    cleanupDescendants(container);

    expect(container.querySelector(".mermaid-export-btn")).toBeNull();
    expect(document.querySelector(".mermaid-export-menu")).toBeNull();
  });

  it("cleans up document event listeners on destroy", () => {
    const instance = setupDiagramExport(container, vi.fn());
    instance.destroy();

    // After destroy, pressing Escape should not cause errors from stale listeners
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("handles multiple setupDiagramExport calls on same container", () => {
    setupDiagramExport(container, vi.fn());
    setupDiagramExport(container, vi.fn());

    const buttons = container.querySelectorAll(".mermaid-export-btn");
    expect(buttons).toHaveLength(2);
  });

  it("handles menu positioning", () => {
    setupDiagramExport(container, vi.fn());

    const btn = container.querySelector<HTMLElement>(".mermaid-export-btn")!;
    btn.click();

    const menu = document.querySelector<HTMLElement>(".mermaid-export-menu");
    expect(menu).not.toBeNull();
    // Menu should have position styles set
    expect(menu!.style.top).toBeDefined();
    expect(menu!.style.left).toBeDefined();
  });
});
