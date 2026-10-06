// WI-RA14D.1 — a failed bootstrap is logged through appError rather than
// escaping as an unhandled rejection, which would leave a blank window with
// nothing in the log. The success path is main.test.tsx; see its note on why
// the two cannot share a file.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { APP_GRAPH_IMPORT_WAIT } from "@/test/waitBudget";

const entry = vi.hoisted(() => ({
  rendered: [] as ReactNode[],
  appError: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: () => ({
      render: (tree: ReactNode) => {
        entry.rendered.push(tree);
      },
    }),
  },
}));
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/debug")>()),
  appError: entry.appError,
}));

describe("main entry, failing bootstrap", () => {
  it("logs the failure through appError and renders nothing", async () => {
    // No #root: bootstrap throws "Root element not found" after loading App.
    expect(document.getElementById("root")).toBeNull();
    await import("./main");

    await vi.waitFor(
      () =>
        expect(entry.appError).toHaveBeenCalledWith(
          "App bootstrap failed:",
          expect.objectContaining({ message: "Root element not found" }),
        ),
      APP_GRAPH_IMPORT_WAIT,
    );
    expect(entry.rendered).toHaveLength(0);
  });
});
