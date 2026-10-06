// WI-RA8.1 — a link or a form in a standalone `.svg` / `.mmd` preview never
// navigates the app's webview; a link opens through VMark's own opener.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { PreviewRendererProps } from "../../types";

const { openUrlMock, renderMermaidMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(async () => undefined),
  renderMermaidMock: vi.fn<(source: string) => Promise<string | null>>(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));
// Mermaid needs real layout to render; the adapter only needs its SVG.
vi.mock("@/plugins/mermaid", () => ({ renderMermaid: renderMermaidMock }));

import { svgFormat } from "../svg";
import { mermaidFormat } from "../mermaid";

const LINKED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
  '<a href="https://example.com/diagram"><text>go</text></a></svg>';

function props(content: string): PreviewRendererProps {
  return { content, liveContent: content, path: "/Users/a/notes/doc.svg", diagnostics: [] };
}

const click = () => new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 });

// The opener imports the settings store lazily; pay for that module graph
// once, here, rather than inside the first test that clicks.
beforeAll(async () => {
  await import("@/stores/settingsStore");
});

beforeEach(() => {
  openUrlMock.mockClear();
});

describe("the standalone SVG preview", () => {
  const SvgPreview = svgFormat.genericPreview!;

  it("prevents a click on a link and opens it through the app's opener", async () => {
    const { container } = render(<SvgPreview {...props(LINKED_SVG)} />);
    const event = click();
    container.querySelector("a text")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/diagram"));
  });

  it("keeps guarding after the document is edited", async () => {
    const { container, rerender } = render(<SvgPreview {...props(LINKED_SVG)} />);
    rerender(<SvgPreview {...props(LINKED_SVG.replace("/diagram", "/edited"))} />);
    const event = click();
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/edited"));
  });

  it("guards the surface that replaces an invalid document", () => {
    const { container, rerender } = render(<SvgPreview {...props("<svg><unclosed></svg>")} />);
    rerender(<SvgPreview {...props(LINKED_SVG)} />);
    const event = click();
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents a form submit", () => {
    const { container } = render(<SvgPreview {...props(LINKED_SVG)} />);
    // The sanitizer removes a document's own <form>; the guard holds even if
    // one reaches the surface some other way.
    const form = document.createElement("form");
    form.action = "https://evil.example/collect";
    container.querySelector(".svg-preview")!.appendChild(form);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });
});

describe("the standalone Mermaid preview", () => {
  const MermaidPreview = mermaidFormat.genericPreview!;

  it("prevents a click on a diagram link and opens it through the app's opener", async () => {
    renderMermaidMock.mockResolvedValue(LINKED_SVG);
    const { container } = render(<MermaidPreview {...props("flowchart LR\n  A --> B")} />);
    await waitFor(() => expect(container.querySelector("a")).not.toBeNull());
    const event = click();
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://example.com/diagram"));
  });
});
