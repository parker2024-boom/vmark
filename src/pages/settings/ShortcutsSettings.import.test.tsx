// WI-RA19.1 — a rejected shortcut import is reported through the app's error
// toast (translated title, each problem listed), never through a raw
// window.alert, which is unstyled and blocks the settings window.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("@/services/dialogs/confirmAction", () => ({ confirmAction: vi.fn() }));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/services/ime/imeToast", () => ({
  imeToast: { error: toastError },
}));

import { ShortcutsSettings } from "./ShortcutsSettings";
import { useShortcutsStore } from "@/stores/settingsStore";

/** Select `text` as the file in the hidden import input and wait for the read. */
async function importFile(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
  const file = new File([text], "shortcuts.json", { type: "application/json" });
  fireEvent.change(input, { target: { files: [file] } });
}

let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  useShortcutsStore.setState({ customBindings: {} });
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
});

describe("shortcut import errors", () => {
  it("shows an error toast with the translated title and every problem, not an alert", async () => {
    const { container } = render(<ShortcutsSettings />);
    await importFile(container, "{ not json");

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Nothing was imported. Fix these problems in the file and try again:");
    expect(opts.description.length).toBeGreaterThan(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("lists each reported problem on its own line", async () => {
    const { container } = render(<ShortcutsSettings />);
    const bad = JSON.stringify({ customBindings: { bold: 42, noSuchShortcut: "Mod-k" } });
    await importFile(container, bad);

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    const [, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(opts.description).toBe("Invalid key for bold\nUnknown shortcut: noSuchShortcut");
  });

  it("stays silent on a successful import", async () => {
    const { container } = render(<ShortcutsSettings />);
    await importFile(container, JSON.stringify({ customBindings: { bold: "Mod-Alt-b" } }));
    // The toast decision runs in the same callback that applies the bindings,
    // so once they are applied the error branch has already been passed.
    await vi.waitFor(() =>
      expect(useShortcutsStore.getState().customBindings).toEqual({ bold: "Mod-Alt-b" }),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
