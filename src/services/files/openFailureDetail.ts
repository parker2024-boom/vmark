/**
 * Open-failure detail
 *
 * Purpose: the second line of a "failed to open file" toast. A failure VMark
 * itself diagnosed is described in the user's language; anything else (a
 * system or command error) is passed through for `imeToast.errorDetail` to
 * normalize as before.
 *
 * Key decisions:
 *   - Translate at presentation, not at the throw: the error's message stays
 *     English for logs and for MCP replies that carry it.
 *
 * @coordinates-with services/files/readDocumentText.ts — UnsupportedEncodingError
 * @coordinates-with services/ime/imeToast.ts — errorDetail renders the result
 * @module services/files/openFailureDetail
 */
import i18n from "@/i18n";
import { UnsupportedEncodingError } from "./readDocumentText";

/** The toast detail for an open failure: translated when VMark knows the cause. */
export function openFailureDetail(error: unknown): unknown {
  if (error instanceof UnsupportedEncodingError) {
    return i18n.t("dialog:toast.unsupportedEncodingDetail", {
      path: error.path,
      encoding: error.encoding,
    });
  }
  return error;
}
