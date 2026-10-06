/**
 * The keybinding drift gate's cross-language legs, run for every synced
 * entry: the Rust contract mirror, the REAL menu builder and the docs table
 * must each carry the accelerator the definitions bind — and, in reverse,
 * every accelerator either Rust source binds must belong to a synced entry.
 *
 * Purpose: these are the comparisons that catch real drift. Each problem is
 * pushed onto the caller's `errors` list so the gate reports them all at once.
 *
 * @coordinates-with scripts/check-keybinding-manifest.mjs — the CLI that loads the sources and reports
 * @coordinates-with scripts/lib/keybindingFormat.mjs — the accelerator converters the comparisons use
 * @module scripts/lib/keybindingManifest/entryChecks
 */
import { keyTokens, prosemirrorToDocs, prosemirrorToTauri } from "../keybindingFormat.mjs";
import { DEFS_PATH, DOCS_PATH, LOCALIZED_DIR, RUST_PATH } from "./context.mjs";
import { canonAccel, coveringRange } from "./docsAccels.mjs";

/** Per-entry checks: each synced entry against the mirror, the real menu and the docs. */
export function checkEntries({
  manifest, defById, rustDefault, rustPlatform, realDefault, realPlatform,
  docsAccels, docsRangeCells, docsRangeDocumented: DOCS_RANGE_DOCUMENTED, errors,
}) {
  const seenIds = new Set();
  for (const entry of manifest) {
    const { id, menuId } = entry;
    if (seenIds.has(id)) {
      errors.push(`manifest: duplicate id "${id}"`);
      continue;
    }
    seenIds.add(id);

    if (!menuId) {
      errors.push(`manifest "${id}": missing menuId`);
      continue;
    }

    const def = defById.get(id);
    if (!def) {
      // Unreachable while the set is derived from `defs`; kept as a fail-closed
      // guard so a future re-plumbing of the source cannot skip entries silently.
      errors.push(`"${id}": no matching entry in ${DEFS_PATH}`);
      continue;
    }
    const manKey = entry.defaultKey ?? "";
    const manOther = entry.defaultKeyOther;
    // `defaultKeyMac` is runtime-wired (settingsStore/shortcuts.ts resolves it on
    // macOS) but no entry uses it yet. Still validate it so the day one appears, the
    // gate compares the macOS surfaces against the override rather than defaultKey.
    // `macKey`/`manMac` below feed the macOS Rust + real-menu
    // checks; they collapse to `manKey` while defaultKeyMac is absent.
    const defMac = def.defaultKeyMac;
    const manMac = entry.defaultKeyMac;
    if (defMac !== manMac) {
      errors.push(
        `"${id}": manifest defaultKeyMac ${JSON.stringify(manMac)} !== ` +
          `${DEFS_PATH} ${JSON.stringify(defMac)}`,
      );
    }
    const macKey = manMac ?? manKey;
    if ((def.menuId ?? "") !== menuId) {
      errors.push(`"${id}": manifest menuId "${menuId}" !== ${DEFS_PATH} "${def.menuId ?? ""}"`);
    }

    // 2. Matches the Rust menu accelerator contract.
    if (rustPlatform.has(menuId)) {
      const { mac, other } = rustPlatform.get(menuId);
      const gotMac = prosemirrorToTauri(macKey);
      const gotOther = prosemirrorToTauri(manOther ?? "");
      if (gotMac !== mac) {
        errors.push(`"${id}" (${menuId}): macOS accel ${JSON.stringify(gotMac)} !== Rust ${JSON.stringify(mac)}`);
      }
      if (gotOther !== other) {
        errors.push(`"${id}" (${menuId}): other accel ${JSON.stringify(gotOther)} !== Rust ${JSON.stringify(other)}`);
      }
    } else if (rustDefault.has(menuId)) {
      const got = prosemirrorToTauri(manKey);
      const want = rustDefault.get(menuId);
      if (got !== want) {
        errors.push(`"${id}" (${menuId}): accel ${JSON.stringify(got)} !== Rust ${JSON.stringify(want)}`);
      }
    } else {
      errors.push(`"${id}" (${menuId}): menuId absent from Rust DEFAULT_ACCELERATORS / PLATFORM_ACCELERATORS`);
    }

    // 3. Matches the REAL menu builder's accel(...) call site (not just the mirror).
    const wantAccel = prosemirrorToTauri(manKey);
    const wantAccelMac = prosemirrorToTauri(macKey);
    if (manOther !== undefined) {
      const rp = realPlatform.get(menuId);
      if (!rp) {
        errors.push(
          `"${id}" (${menuId}): manifest is platform-conditional but the real menu ` +
            `builder (${LOCALIZED_DIR}) has no platform-conditional accel("${menuId}", …) site`,
        );
      } else {
        const wantOther = prosemirrorToTauri(manOther);
        if (rp.mac !== wantAccelMac) {
          errors.push(`"${id}" (${menuId}): real menu macOS accel ${JSON.stringify(rp.mac)} !== prosemirrorToTauri(defaultKeyMac ?? defaultKey) ${JSON.stringify(wantAccelMac)}`);
        }
        if (rp.other !== wantOther) {
          errors.push(`"${id}" (${menuId}): real menu other accel ${JSON.stringify(rp.other)} !== prosemirrorToTauri(defaultKeyOther) ${JSON.stringify(wantOther)}`);
        }
      }
    } else if (realDefault.has(menuId)) {
      const got = realDefault.get(menuId);
      if (got !== wantAccel) {
        errors.push(`"${id}" (${menuId}): real menu accel ${JSON.stringify(got)} !== prosemirrorToTauri(defaultKey) ${JSON.stringify(wantAccel)}`);
      }
    } else if (realPlatform.has(menuId)) {
      errors.push(`"${id}" (${menuId}): real menu builder is platform-conditional but the manifest entry is not`);
    } else {
      errors.push(`"${id}" (${menuId}): no accel("${menuId}", …) call site in the real menu builder ${LOCALIZED_DIR}`);
    }

    // 4. Documented in the website shortcuts table (order-insensitive).
    //
    // Every EFFECTIVE platform key, not just `defaultKey`. `defaultKeyMac`
    // overrides on macOS and `defaultKeyOther` off it, so what a user can press
    // is `defaultKeyMac ?? defaultKey` on one platform and
    // `defaultKeyOther ?? defaultKey` on the other. The leg used to read
    // `defaultKey` and `defaultKeyOther` only, so a macOS override went
    // undocumented with nothing to fail on — and, worse, an entry with an EMPTY
    // `defaultKey` skipped the whole leg even when the macOS override was a real
    // chord. No entry uses `defaultKeyMac` today, which is exactly
    // why the gap was invisible; the Rust legs above already read `macKey`.
    const docKeys = [...new Set([macKey, manOther ?? manKey])].filter((k) => k !== undefined && k !== "");
    if (docKeys.length === 0) {
      // Deliberately unbound: docs render it as "—" / "Menu only" / "(customizable)".
      // Nothing to locate; the empty accelerator is already covered above.
    } else if (DOCS_RANGE_DOCUMENTED.has(menuId)) {
      // Documented only inside a compressed range cell — an allowed exception,
      // but only while the docs actually carry a range that covers it.
      for (const key of docKeys) {
        if (coveringRange(docsRangeCells, keyTokens(key))) continue;
        errors.push(
          `stale DOCS_RANGE_DOCUMENTED entry "${menuId}" (${DOCS_RANGE_DOCUMENTED.get(menuId)}): ` +
            `no "\`A\` through \`B\`" cell in ${DOCS_PATH} covers "${prosemirrorToDocs(key)}". ` +
            "The exemption removes the id from the docs check entirely, so a deleted or " +
            "narrowed range would take the shortcut out of the gate with nothing to fail on — " +
            "restore the range, or delete the exemption so the accelerator is documented on its own row.",
        );
      }
    } else {
      for (const key of docKeys) {
        if (docsAccels.has(canonAccel(keyTokens(key)))) continue;
        errors.push(
          `"${id}" (${menuId}): accelerator "${prosemirrorToDocs(key)}" is missing ` +
            `from the docs table ${DOCS_PATH} — a menu-backed shortcut must be documented`,
        );
      }
    }
  }
}

/** Reverse checks: every accelerator either Rust source binds maps to a synced entry. */
export function checkOrphanAccels({
  manifestMenuIds, dynamicMenuIds: DYNAMIC_MENU_IDS, nonManifestMenuAccels: NON_MANIFEST_MENU_ACCELS,
  realDefault, realPlatform, rustDefault, rustPlatform, errors,
}) {
  // --- Reverse: every non-empty accel the real menu binds maps to a manifest entry ---
  function reportOrphanRealAccel(id, accelDesc) {
    if (manifestMenuIds.has(id)) return;
    if (DYNAMIC_MENU_IDS.has(id)) return;
    if (NON_MANIFEST_MENU_ACCELS.has(id)) return;
    errors.push(
      `real menu builder binds ${accelDesc} to menu id "${id}", which is absent from ` +
        `the synced set — give it a menuId entry in ${DEFS_PATH} (or allow-list ` +
        `it in NON_MANIFEST_MENU_ACCELS with a reason)`,
    );
  }
  for (const [id, accel] of realDefault) {
    if (accel === "") continue; // unbound-by-default menu item: nothing to reconcile
    reportOrphanRealAccel(id, JSON.stringify(accel));
  }
  for (const [id, { mac, other }] of realPlatform) {
    if (mac === "" && other === "") continue;
    reportOrphanRealAccel(id, `${JSON.stringify(mac)}/${JSON.stringify(other)}`);
  }

  // --- Reverse: every CONTRACT MIRROR tuple maps to a manifest entry too ------
  //
  // The per-entry legs above walk the manifest and look each id UP in the mirror,
  // so an id the mirror carries and nothing else does was never examined: a
  // renamed or deleted shortcut left its old tuple behind in
  // `localized.test.rs`, where it kept validating against itself while the gate
  // reported green. The real-menu direction has had this check
  // since the leg was written; the mirror is the same shape and needed the same
  // one, with the same allow-lists — an id excluded from the manifest on purpose
  // is excluded from both directions or from neither.
  function reportOrphanMirrorAccel(id, table, accelDesc) {
    if (manifestMenuIds.has(id)) return;
    if (DYNAMIC_MENU_IDS.has(id)) return;
    if (NON_MANIFEST_MENU_ACCELS.has(id)) return;
    errors.push(
      `${RUST_PATH}: ${table} holds ${accelDesc} for menu id "${id}", which is absent from ` +
        `the synced set — the tuple is stale (delete it), or the id needs a menuId entry in ` +
        `${DEFS_PATH} (or an allow-list entry in NON_MANIFEST_MENU_ACCELS with a reason)`,
    );
  }
  for (const [id, accel] of rustDefault) {
    if (accel === "") continue; // unbound-by-default menu item — same rule as the real-menu leg
    reportOrphanMirrorAccel(id, "DEFAULT_ACCELERATORS", JSON.stringify(accel));
  }
  for (const [id, { mac, other }] of rustPlatform) {
    if (mac === "" && other === "") continue;
    reportOrphanMirrorAccel(id, "PLATFORM_ACCELERATORS", `${JSON.stringify(mac)}/${JSON.stringify(other)}`);
  }
}
