// @vitest-environment node
// WI-RA10B.9 — the genie picker loads every genie with one IPC call.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { useGeniesStore } from "../aiStore";

beforeEach(() => {
  useGeniesStore.setState({ genies: [], loading: false, recentGenieNames: [], favoriteGenieNames: [] });
  vi.mocked(invoke).mockReset();
});

describe("loadGenies — one batch", () => {
  const entry = (name: string) => ({ name, path: `/genies/${name}.md`, source: "global", category: null });
  const content = (name: string) => ({
    metadata: { name, description: "d", scope: "selection" },
    template: `template of ${name}`,
  });

  it("loads every genie with one IPC call, however many there are", async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Genie${i}`);
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "load_genies" ? names.map((name) => ({ ...entry(name), content: content(name) })) : undefined,
    );

    await useGeniesStore.getState().loadGenies();

    expect(useGeniesStore.getState().genies.map((g) => g.metadata.name)).toEqual(names);
    expect(useGeniesStore.getState().genies[7].template).toBe("template of Genie7");
    expect(vi.mocked(invoke).mock.calls).toEqual([["load_genies"]]);
  });

  it("skips a genie the backend could not read and keeps the rest", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "load_genies"
        ? [
            { ...entry("Good"), content: content("Good") },
            { ...entry("Bad"), error: { code: "invalid-input", message: "not a genie" } },
          ]
        : undefined,
    );

    await useGeniesStore.getState().loadGenies();

    expect(useGeniesStore.getState().genies.map((g) => g.metadata.name)).toEqual(["Good"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("reads one by one the genies the answer had no room for", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === "load_genies") {
        return [{ ...entry("Fits"), content: content("Fits") }, entry("Deferred"), entry("Gone")];
      }
      if (cmd === "read_genie" && (args as { path?: string }).path === "/genies/Deferred.md") return content("Deferred");
      throw new Error("vanished");
    });

    await useGeniesStore.getState().loadGenies();

    expect(useGeniesStore.getState().genies.map((g) => g.metadata.name)).toEqual(["Fits", "Deferred"]);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["load_genies"],
      ["read_genie", { path: "/genies/Deferred.md" }],
      ["read_genie", { path: "/genies/Gone.md" }],
    ]);
  });

  it("keeps the workflow kind and the folder category of a batched entry", async () => {
    vi.mocked(invoke).mockImplementation(async () => [
      { ...entry("Flow"), kind: "workflow", category: "流程", content: content("Flow") },
    ]);

    await useGeniesStore.getState().loadGenies();

    const [flow] = useGeniesStore.getState().genies;
    expect(flow.kind).toBe("workflow");
    expect(flow.metadata.category).toBe("流程");
  });
});
