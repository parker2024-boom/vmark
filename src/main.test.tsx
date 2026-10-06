// WI-RA14D.1 — the entry module boots the real App into #root.
//
// Everything below the entry runs for real — bootstrap, secure storage, the
// App module. The boundaries are react-dom's root (so nothing actually mounts)
// and the error logger. Loading the real App graph costs about twice the editor
// surface, so the waits use their own budget class (APP_GRAPH_IMPORT_WAIT).
//
// One import of the entry per file: the App graph registers ProseMirror
// selection classes globally, so a second evaluation in the same worker throws
// "Duplicate use of selection JSON ID". The failure path lives in
// main.bootFailure.test.tsx for that reason.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
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

/** StrictMode > BrowserRouter > App — return the innermost element's type. */
function innermostType(tree: ReactNode): unknown {
  let node = tree as ReactElement<{ children?: ReactNode }>;
  while (node.props.children) {
    node = node.props.children as ReactElement<{ children?: ReactNode }>;
  }
  return node.type;
}

describe("main entry", () => {
  it("renders the App module's default export into #root", async () => {
    document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));
    await import("./main");

    await vi.waitFor(() => expect(entry.rendered).toHaveLength(1), APP_GRAPH_IMPORT_WAIT);
    const { default: App } = await import("./App");
    expect(innermostType(entry.rendered[0])).toBe(App);
    expect(entry.appError).not.toHaveBeenCalled();
  });
});
