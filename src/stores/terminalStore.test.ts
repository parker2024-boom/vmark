// @vitest-environment node
// WI-RA17D.4 — terminal session state lives in its own store, not in uiStore.
// Pins the store boundary (no field in both stores, no `terminal` namespace
// left on uiStore) and the base session actions that moved with it.
import { beforeEach, describe, expect, it } from "vitest";
import { resetTerminalSessionStore, useTerminalStore } from "./terminalStore";
import { useUIStore } from "./uiStore";

const store = () => useTerminalStore.getState();
const create = () => store().terminalCreateSession()!;

beforeEach(() => {
  resetTerminalSessionStore();
});

describe("store boundary", () => {
  it("uiStore no longer carries the terminal session namespace", () => {
    expect("terminal" in useUIStore.getState()).toBe(false);
  });

  it("no terminalStore key is also a uiStore key", () => {
    const ui = useUIStore.getState() as unknown as Record<string, unknown>;
    const shared = Object.keys(store()).filter((key) => key in ui);
    expect(shared).toEqual([]);
  });

  it("panel chrome (visibility, size, position) stays in uiStore", () => {
    const ui = useUIStore.getState();
    expect(typeof ui.terminalVisible).toBe("boolean");
    expect(typeof ui.terminalHeight).toBe("number");
    expect(typeof ui.terminalWidth).toBe("number");
    expect(typeof ui.toggleTerminal).toBe("function");
  });

  it("starts empty and the reset restores the empty state and id counter", () => {
    create();
    resetTerminalSessionStore();
    expect(store().sessions).toEqual([]);
    expect(store().activeSessionId).toBeNull();
    expect(store().lastActiveByScope).toEqual({});
    expect(create().id).toBe("term-1");
  });
});

describe("session actions", () => {
  it("terminalCreateSession adds a session and marks it active", () => {
    const session = store().terminalCreateSession();
    expect(session).not.toBeNull();
    expect(store().sessions).toHaveLength(1);
    expect(store().activeSessionId).toBe(session!.id);
    expect(session!.isAlive).toBe(true);
  });

  it("terminalRemoveSession picks the last remaining session as active", () => {
    const a = create();
    const b = create();
    store().terminalRemoveSession(b.id);
    expect(store().activeSessionId).toBe(a.id);
  });

  it("terminalRemoveSession sets active to null when no sessions remain", () => {
    const a = create();
    store().terminalRemoveSession(a.id);
    expect(store().activeSessionId).toBeNull();
  });

  it("terminalRemoveSession leaves active untouched when removing a non-active session", () => {
    const a = create();
    const b = create();
    store().terminalRemoveSession(a.id);
    expect(store().activeSessionId).toBe(b.id);
  });

  it("terminalSetActiveSession switches to an existing session only", () => {
    const a = create();
    create();
    store().terminalSetActiveSession(a.id);
    expect(store().activeSessionId).toBe(a.id);
    store().terminalSetActiveSession("does-not-exist");
    expect(store().activeSessionId).toBe(a.id);
  });

  it("terminalMarkActivity flags a session, and activating it clears the flag (WI-4.3)", () => {
    const a = create();
    const b = create();
    // b is active (most recent). Mark activity on the background session a.
    store().terminalMarkActivity(a.id);
    expect(store().sessions.find((s) => s.id === a.id)?.hasActivity).toBe(true);
    expect(store().sessions.find((s) => s.id === b.id)?.hasActivity).toBeFalsy();
    store().terminalSetActiveSession(a.id);
    expect(store().sessions.find((s) => s.id === a.id)?.hasActivity).toBe(false);
  });

  it("terminalMarkActivity is a no-op for the active session", () => {
    create();
    const b = create();
    // Marking the visible session would leave a stale dot after switching away.
    store().terminalMarkActivity(b.id);
    expect(store().sessions.find((s) => s.id === b.id)?.hasActivity).toBeFalsy();
  });

  it("terminalMarkSessionDead / Alive flip the isAlive flag", () => {
    const s = create();
    store().terminalMarkSessionDead(s.id);
    expect(store().sessions[0].isAlive).toBe(false);
    store().terminalMarkSessionAlive(s.id);
    expect(store().sessions[0].isAlive).toBe(true);
  });

  it("a stale event for an unknown id does not wake the store", () => {
    create();
    const before = store().sessions;
    store().terminalMarkSessionDead("gone");
    expect(store().sessions).toBe(before);
  });

  it("terminalRenameSession updates the label and locks it against program titles", () => {
    const s = create();
    expect(store().sessions[0].isUserRenamed).toBeFalsy();
    store().terminalRenameSession(s.id, "renamed");
    expect(store().sessions[0].label).toBe("renamed");
    expect(store().sessions[0].isUserRenamed).toBe(true);
  });

  it("terminalSetProgramTitle stores the title; unknown ids are a no-op", () => {
    const s = create();
    store().terminalSetProgramTitle(s.id, "vim");
    expect(store().sessions[0].programTitle).toBe("vim");
    store().terminalSetProgramTitle("does-not-exist", "emacs");
    expect(store().sessions[0].programTitle).toBe("vim");
  });

  it("terminalSetProgramTitle strips control chars, collapses whitespace, and caps length", () => {
    const s = create();
    // A hostile program can emit control chars / huge titles via OSC 0/2.
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(27);
    const DEL = String.fromCharCode(127);
    store().terminalSetProgramTitle(s.id, `ok${NUL}${ESC}[31m  bad${DEL}`);
    expect(store().sessions[0].programTitle).toBe("ok[31m bad");
    store().terminalSetProgramTitle(s.id, "x".repeat(500));
    expect(store().sessions[0].programTitle).toHaveLength(256);
  });

  it("terminalSetProgramTitle strips C1 controls and bidi overrides, keeps CJK", () => {
    const s = create();
    const C1 = "\u0085";
    const RLO = "‮";
    const LRI = "⁦";
    const PDI = "⁩";
    store().terminalSetProgramTitle(s.id, `${RLO}dm.txet${PDI}${C1}vim ${LRI}日本語`);
    expect(store().sessions[0].programTitle).toBe("dm.txetvim 日本語");
  });

  it("requestedCwd is peeked without consuming and cleared by taking the key off", () => {
    const s = store().terminalCreateSession({ requestedCwd: "/tmp/项目" })!;
    expect(store().terminalPeekRequestedCwd(s.id)).toBe("/tmp/项目");
    expect(store().terminalPeekRequestedCwd(s.id)).toBe("/tmp/项目");
    store().terminalClearRequestedCwd(s.id);
    expect(Object.keys(store().sessions[0])).not.toContain("requestedCwd");
  });
});
