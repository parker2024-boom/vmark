// Runs under jsdom, the default: viewCommands imports contentServerStore, which
// publishes a DEV debug handle on `window` at import time.
// Audit 20260907 (#453): registerAllCommands is a sequence of registrars, each
// guarded by a first-command sentinel. If one threw part-way, everything the
// batch had already registered stayed on the bus, and the retry the bootstrap
// effect makes on remount saw the sentinels and skipped — a permanently
// partial registry. The batch now rolls back every id it added and re-throws.
//
// Every registrar runs real. The failure is a real one too: a foreign
// registration holding an id the genie registrar (late in the sequence) owns
// makes its collision preflight throw, after every earlier group registered.
import { describe, it, expect, beforeEach } from "vitest";

import { registerAllCommands } from "./registerAllCommands";
import {
  getCommand,
  listCommands,
  registerCommand,
  registerCommands,
  unregisterCommand,
  _resetCommandBus,
} from "./CommandBus";

const ids = () => listCommands().map((c) => c.id).sort();

/** An id the genie registrar owns; holding it makes that registrar throw. */
const GENIE_ID = "genies.togglePicker";
/** The tab registrar's owner token and one of its ids (an owner batch that
 *  runs BEFORE the genie registrar). */
const TAB_OWNER = "tab-commands";
const TAB_ID = "tab.new";

/** Hold the genie registrar's id under a foreign registration. */
function blockGenie(): void {
  registerCommand({ id: GENIE_ID, title: "Foreign registrar", run: () => {} });
}

beforeEach(() => {
  _resetCommandBus();
});

describe("registerAllCommands", () => {
  it("registers every group and returns the editor batch's disposer", () => {
    const dispose = registerAllCommands();
    // One id from the first registrar, the genie registrar and the editor bridge.
    expect(ids()).toContain("app.preferences");
    expect(ids()).toContain(GENIE_ID);
    expect(ids()).toContain("editor.bold");
    dispose();
    expect(ids().some((id) => id.startsWith("editor."))).toBe(false);
    expect(ids()).toContain("app.preferences");
    expect(ids()).toContain(GENIE_ID);
  });

  it("rolls back every command the batch added when a registrar throws, so a retry starts clean", () => {
    blockGenie();
    expect(() => registerAllCommands()).toThrow(/already registered/);
    // Nothing partial survives — not one of the groups before the failure.
    expect(ids()).toEqual([GENIE_ID]);

    unregisterCommand(GENIE_ID);
    expect(() => registerAllCommands()).not.toThrow();
    expect(ids()).toContain("app.preferences");
    expect(ids()).toContain(GENIE_ID);
    expect(ids()).toContain("editor.bold");
  });

  it("leaves commands registered BEFORE the batch untouched on rollback", () => {
    registerCommand({ id: "pre.existing", title: "pre", run: () => {} });
    blockGenie();
    expect(() => registerAllCommands()).toThrow(/already registered/);
    expect(ids()).toEqual([GENIE_ID, "pre.existing"].sort());
    expect(getCommand("pre.existing")?.title).toBe("pre");
  });

  // Round 3: the snapshot was a set of IDs, so rollback could only DELETE. A
  // registrar that re-registers an owner batch (`registerCommands`) replaces
  // the previous one first — ids removed, then re-added under a fresh token —
  // and an id-only rollback cannot tell that apart from "was already there".
  // The bus therefore kept the failed attempt's definitions and its new
  // generation, and the disposer the previous batch had handed out no longer
  // matched, so nothing could take them off again.
  it("restores the DEFINITIONS an owner batch replaced before the failure", () => {
    const disposePrevious = registerCommands(TAB_OWNER, [{ id: TAB_ID, title: "tab v1", run: () => {} }]);
    blockGenie();
    expect(() => registerAllCommands()).toThrow(/already registered/);

    // Not merely "tab.new still exists" — the ORIGINAL definition is back.
    expect(getCommand(TAB_ID)?.title).toBe("tab v1");
    // And the pre-batch disposer still owns it: the failed attempt's token
    // must not have survived the rollback.
    disposePrevious();
    expect(ids()).toEqual([GENIE_ID]);
  });
});
