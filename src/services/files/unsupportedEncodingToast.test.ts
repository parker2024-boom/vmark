// @vitest-environment node
// WI-RA22.7 — opening a UTF-16/UTF-32 file shows a translated detail (the
// encoding and path as parameters) under the translated headline, not the
// error's technical English message.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.fsModule();
});
vi.mock("@tauri-apps/api/core", async () => {
  const { statefulFs } = await import("@/test/statefulFsFake");
  return statefulFs.coreModule();
});
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import i18n from "@/i18n";
import { statefulFs } from "@/test/statefulFsFake";
import { openFileInNewTab } from "@/services/navigation/fileOpen";
import { UnsupportedEncodingError } from "@/services/files/readDocumentText";
import { openFailureDetail } from "@/services/files/openFailureDetail";
import { ROOT, WINDOW, resetTier0 } from "@/test/tier0/harness";

const DOC = `${ROOT}/笔记.md`;

beforeEach(() => {
  resetTier0();
  toastError.mockClear();
});

describe("the unsupported-encoding open failure is translated", () => {
  it.each([
    ["UTF-16LE", [0xff, 0xfe, 0x23, 0x00]],
    ["UTF-16BE", [0xfe, 0xff, 0x00, 0x23]],
    ["UTF-32LE", [0xff, 0xfe, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00]],
    ["UTF-32BE", [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x23]],
  ])("a %s file's toast detail comes from the locale", async (encoding, bytes) => {
    statefulFs.seedBytes(DOC, Uint8Array.from(bytes));

    await openFileInNewTab(WINDOW, DOC);

    expect(toastError).toHaveBeenCalledTimes(1);
    const [headline, options] = toastError.mock.calls[0] as [string, { description?: string }];
    expect(headline).toBe(i18n.t("dialog:toast.failedToOpenFile"));
    const expected = i18n.t("dialog:toast.unsupportedEncodingDetail", { path: DOC, encoding });
    expect(expected).not.toBe("dialog:toast.unsupportedEncodingDetail"); // the key resolves
    expect(options.description).toBe(expected);
    expect(options.description).toContain(encoding);
    expect(options.description).toContain(DOC);
    expect(options.description).not.toContain("byte-order mark");
  });
});

describe("openFailureDetail", () => {
  it("translates an UnsupportedEncodingError", () => {
    const error = new UnsupportedEncodingError("/d/a.md", "UTF-16LE", [0xff, 0xfe]);
    expect(openFailureDetail(error)).toBe(
      i18n.t("dialog:toast.unsupportedEncodingDetail", { path: "/d/a.md", encoding: "UTF-16LE" }),
    );
  });

  it("passes any other failure through unchanged", () => {
    const error = new Error("No such file or directory");
    expect(openFailureDetail(error)).toBe(error);
    const typed = { code: "NOT_FOUND", message: "missing" };
    expect(openFailureDetail(typed)).toBe(typed);
    expect(openFailureDetail(undefined)).toBeUndefined();
  });
});
