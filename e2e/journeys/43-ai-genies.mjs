/**
 * Journey: ai-genies
 *
 * The genie promise (website/guide/ai-genies.md): select text, open the picker,
 * run a prompt, review the suggestion, accept it — and the document holds the
 * AI's text. The jsdom tier (src/test/tier0/genieFlow.test.tsx) pins the same
 * flow with `invoke`/`listen` faked; this journey runs it against the live
 * app, including the Rust provider stack.
 *
 * PART 1 — the picker. `menu:search-genies` (bound to `genies.openPicker` in
 * hooks/useCommandBootstrap.ts) opens it; it lists the genies `load_genies`
 * found, or shows its empty state; typing narrows the list; Escape closes it.
 * Where it mounts is asserted as the source has it: GeniePicker.tsx portals a
 * `.vm-overlay` onto `document.body` (an app-level modal, mounted by App.tsx
 * through GeniePickerOverlay), NOT inside the editor container.
 *
 * PART 2 — a run, with NO real provider and NO outside network. Emitting
 * `ai:response` frames from the page cannot stand in for a provider:
 * `run_ai_prompt` always dispatches (ai_provider/dispatch.rs) and its own
 * terminal frame would race anything the page emitted. What CAN be arranged is
 * the provider itself. `ollama-api` needs no key (KEY_OPTIONAL_REST in
 * stores/aiStore/providerSanitize.ts), its endpoint comes from the provider
 * store, and Rust POSTs `{endpoint}/api/generate` and reads `response` from
 * the JSON body (ai_provider/rest_request.rs `ollama_request`,
 * rest_providers.rs `run_rest_ollama`). So this journey serves that one route
 * from a loopback socket in THIS process, points the provider store at it for
 * the length of the run, and restores the store in `finally`. Everything
 * between the picker and the document is then the shipped code: extraction,
 * `run_ai_prompt`, reqwest, the `ai:response` frames Rust emits, the
 * suggestion, Accept.
 *
 * What is NOT real: the model. What stays manual: a CLI provider (it spawns the
 * user's own `claude`/`codex`/`gemini`), key-bearing REST providers (a key
 * would have to be written to the OS keychain), token-by-token streaming (REST
 * answers arrive as one frame), and the native Genies menu itself.
 *
 * STATE THIS TOUCHES, and how it is put back:
 *   - `useAiProviderStore` (activeProvider + the ollama entry's name, endpoint
 *     and model), reached through the dev module graph (e2e/README.md
 *     "Arranging state"). The snapshot stays IN THE PAGE — the store holds API
 *     keys in memory and none of it crosses the bridge. The write is proven
 *     live by the picker's own footer (`via <name>`, a name unique to this
 *     run): a parallel HMR store instance would leave the footer unchanged,
 *     and the journey fails saying so BEFORE anything is submitted — so a
 *     prompt can never reach a provider the user really has configured.
 *   - `usePromptHistoryStore`: a freeform prompt is recorded in history
 *     (hooks/usePromptHistory.ts `recordAndReset`); the entries are restored.
 *   - One scratch tab, force-discarded by `withTabRestore`.
 * A freeform prompt is used rather than a listed genie so the run does not
 * depend on which genie files this profile happens to have.
 *
 * WAITS — every one is `poll()` on something the app renders: the dialog, the
 * list, the no-match hint, the two-step confirmation hint, the preview (or the
 * error view, which fails the journey with the app's own message), the editor
 * text. Store reads are fire-and-poll through a window slot, because the
 * bridge cannot await a page promise (journey 38's rule). The preview wait is
 * the long one: it spans the IPC round trip and one loopback HTTP request.
 */

import { createServer } from "node:http";
import { evalJs } from "../lib/bridge.mjs";
import { readPersistedSettingsSection } from "../lib/settingsPatch.mjs";
import {
  withTabRestore,
  createScratchTab,
  setEditorContent,
  getEditorText,
  selectTextInEditor,
  emitMenu,
  poll,
} from "../lib/vmark.mjs";

const AI_STORES_MODULE = "/src/stores/aiStore.ts";
const RUN_TIMEOUT_MS = 30000;

/** What the picker is showing right now, read from its own DOM. */
const PICKER_SNIPPET = `(() => {
  const panel = document.querySelector('.genie-picker[role="dialog"]');
  if (!panel) return { open: false };
  const text = (sel) => panel.querySelector(sel)?.textContent ?? null;
  return {
    open: true,
    onBody: panel.closest('.vm-overlay')?.parentElement === document.body,
    insideEditor: !!panel.closest('.ProseMirror, .tiptap-editor'),
    modal: panel.getAttribute('aria-modal') === 'true',
    options: [...panel.querySelectorAll('.genie-picker-item[role="option"] .genie-picker-item-name')].map((el) => el.textContent),
    emptyStates: panel.querySelectorAll('.genie-picker-list .genie-picker-empty').length,
    noMatch: !!panel.querySelector('.genie-picker-no-match'),
    confirmHint: !!panel.querySelector('.genie-picker-confirm-hint'),
    filter: panel.querySelector('textarea.genie-picker-search')?.value ?? null,
    scope: text('.genie-picker-scope'),
    provider: text('.provider-switcher-trigger'),
    response: text('.genie-response-text'),
    error: text('.genie-response-error'),
    canAccept: !!panel.querySelector('.genie-response-btn--accept'),
  };
})()`;

const pickerState = (client) => evalJs(client, PICKER_SNIPPET);

/** The picker's row title for a genie name (GenieItem.tsx `formatName`). */
const displayName = (name) => name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Evaluate `body` — the source of a `(stores) => value` function — against the
 * app's AI stores, imported through the dev module graph. Detached, with the
 * outcome parked on a run-scoped slot this polls. The value must be JSON.
 */
async function withAiStores(client, body) {
  const slot = `__vmarkE2eGenie_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await evalJs(
    client,
    `(() => {
       window[${JSON.stringify(slot)}] = { done: false };
       (async () => {
         try {
           const stores = await import(${JSON.stringify(AI_STORES_MODULE)});
           window[${JSON.stringify(slot)}] = { done: true, ok: true, value: (${body})(stores) ?? null };
         } catch (e) {
           window[${JSON.stringify(slot)}] = { done: true, ok: false, error: e && e.message ? e.message : String(e) };
         }
       })();
       return true;
     })()`
  );
  try {
    const outcome = await poll(
      async () => JSON.parse(await evalJs(client, `JSON.stringify(window[${JSON.stringify(slot)}] ?? null)`)),
      (v) => v?.done === true,
      "the AI stores to answer"
    );
    if (!outcome.ok) throw new Error(`AI stores: ${outcome.error}`);
    return outcome.value;
  } finally {
    await evalJs(client, `(delete window[${JSON.stringify(slot)}], true)`).catch(() => {});
  }
}

/** Put `text` in the picker's input the way typing does (a controlled textarea). */
async function typeInPicker(client, text) {
  const ok = await evalJs(
    client,
    `(() => {
       const input = document.querySelector('.genie-picker textarea.genie-picker-search');
       if (!input) return false;
       input.focus();
       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`
  );
  if (!ok) throw new Error("the genie picker has no search input to type into");
  await poll(() => pickerState(client), (s) => s.open && s.filter === text, `the picker input to hold ${JSON.stringify(text)}`);
}

/** Press a key in the picker's input; the dialog's own keydown handler decides. */
function pressInPicker(client, key) {
  return evalJs(
    client,
    `(() => {
       const input = document.querySelector('.genie-picker textarea.genie-picker-search');
       if (!input) return false;
       input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
       return true;
     })()`
  );
}

/**
 * Escape until the picker is gone. Each press is handled synchronously by the
 * dialog's keydown handler: one cancels a run or drops a preview and returns
 * to the input, the next closes the input.
 */
async function dismissPicker(client) {
  for (let i = 0; i < 4; i++) {
    if (!(await pickerState(client)).open) return;
    await pressInPicker(client, "Escape");
  }
  if ((await pickerState(client)).open) throw new Error("the genie picker is still open after four Escapes");
}

/** A loopback stand-in for Ollama's `/api/generate`, answering `answer` to every prompt. */
function startFakeOllama(answer) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // Recorded as null; the assertion on the request body reports it.
      }
      requests.push({ method: req.method, url: req.url, body });
      const known = req.method === "POST" && req.url === "/api/generate";
      res.writeHead(known ? 200 : 404, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(known ? { model: body?.model ?? null, response: answer, done: true } : { error: "not found" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Part 1: open, list (or empty state), narrow, close. */
async function exercisePicker(client, ctx, stamp) {
  await emitMenu(client, "search-genies", ctx.windowLabel);
  const opened = await poll(() => pickerState(client), (s) => s.open, "menu:search-genies to open the genie picker");
  if (!opened.modal || !opened.onBody || opened.insideEditor) {
    throw new Error(`the picker is not the body-level modal overlay GeniePicker.tsx renders: ${JSON.stringify(opened)}`);
  }

  // `load_genies` runs on open; the list is settled once the store says so.
  const loaded = await poll(
    () => withAiStores(client, `(s) => { const g = s.useGeniesStore.getState(); return { loading: g.loading, genies: g.genies.map((x) => ({ name: x.metadata.name, scope: x.metadata.scope })) }; }`),
    (v) => v.loading === false,
    "load_genies to finish"
  );
  const listed = await pickerState(client);
  const scope = ["selection", "block", "document"].find((s) => listed.scope?.includes(s)) ?? null;
  const expected = loaded.genies.filter((g) => !scope || g.scope === scope);
  if (listed.options.length !== expected.length) {
    throw new Error(
      `the picker lists ${listed.options.length} genie(s) but the genies store holds ${expected.length} for scope ` +
        `${scope ?? "all"}. If the app was reloaded after an HMR update, the dev import reached a parallel store ` +
        `instance — restart the app and rerun.`
    );
  }
  if (expected.length === 0) {
    if (listed.emptyStates !== 1) throw new Error(`no genies, but the documented empty state is not shown: ${JSON.stringify(listed)}`);
    ctx.log("no genie files in this profile — the picker shows its empty state");
  } else {
    const target = expected[0].name;
    await typeInPicker(client, target);
    const narrowed = await poll(
      () => pickerState(client),
      (s) => s.options.includes(displayName(target)),
      `the list filtered by ${JSON.stringify(target)} to keep that genie`
    );
    if (narrowed.options.length > listed.options.length) throw new Error("filtering made the genie list LONGER");
    ctx.log(`picker listed ${listed.options.length} genie(s); "${target}" narrows it to ${narrowed.options.length}`);
  }

  // Text no genie matches empties the list and offers the freeform path instead.
  await typeInPicker(client, `no-such-genie-${stamp}`);
  await poll(() => pickerState(client), (s) => s.options.length === 0 && s.noMatch, "a non-matching filter to empty the list");

  await pressInPicker(client, "Escape");
  await poll(() => pickerState(client), (s) => !s.open, "Escape to close the genie picker");
}

export default {
  name: "ai-genies",

  async run(client, ctx) {
    const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const marker = `genieword${stamp}`;
    const answer = `genieanswer${stamp}`;
    const prompt = `reply for e2e run ${stamp}`;
    const keep = `__vmarkE2eGenieKeep_${stamp}`;
    const standIn = `E2E stand-in ${stamp}`;

    const running = await withAiStores(client, `(s) => s.useAiInvocationStore.getState().isRunning`);
    if (running) return { skip: "an AI request is already running in this window — its lock would refuse this run" };
    const autoApprove = (await readPersistedSettingsSection(client, "advanced"))?.mcpServer?.autoApproveEdits === true;

    const ollama = await startFakeOllama(answer);
    try {
      await withTabRestore(client, async ({ track }) => {
        const scratch = await createScratchTab(client);
        track(scratch.id);
        await setEditorContent(client, `alpha ${marker} omega`, { mustBeEmpty: true });
        await poll(() => getEditorText(client), (t) => typeof t === "string" && t.includes(marker), "the scratch document to render");

        let bodyError = null;
        try {
          await exercisePicker(client, ctx, stamp);

          // Point the provider store at the loopback stand-in; the originals stay in the page.
          const arranged = await withAiStores(
            client,
            `(s) => {
               const provider = s.useAiProviderStore.getState();
               const entry = provider.restProviders.find((p) => p.type === "ollama-api");
               if (!entry) return { ok: false };
               window[${JSON.stringify(keep)}] = {
                 activeProvider: provider.activeProvider,
                 restProviders: provider.restProviders,
                 history: s.usePromptHistoryStore.getState().entries,
               };
               s.useAiProviderStore.setState({
                 activeProvider: "ollama-api",
                 restProviders: provider.restProviders.map((p) =>
                   p.type === "ollama-api"
                     ? { ...p, name: ${JSON.stringify(standIn)}, endpoint: ${JSON.stringify(ollama.endpoint)}, model: "e2e-model" }
                     : p),
               });
               return { ok: true };
             }`
          );
          if (!arranged.ok) throw new Error("the provider store has no ollama-api entry to point at the stand-in");

          // A real selection, then the picker: its scope must be the selection.
          await selectTextInEditor(client, marker);
          await emitMenu(client, "search-genies", ctx.windowLabel);
          const ready = await poll(() => pickerState(client), (s) => s.open && s.scope !== null, "the picker to open on the selection");
          if (!ready.scope.includes("selection")) {
            throw new Error(`the picker opened with "${ready.scope}", not the selection scope — the DOM selection did not reach the editor (is the app window in the foreground?)`);
          }
          // The stand-in's name is unique to this run, so no ambient provider can satisfy this.
          if (!ready.provider?.includes(standIn)) {
            throw new Error(
              `the picker shows provider "${ready.provider}", not "${standIn}": the provider write did not reach the live store ` +
                `(a parallel instance after an HMR reload) — restart the app and rerun.`
            );
          }

          // Freeform, two-step: no genie matches, Enter shows the hint, Enter again submits.
          await typeInPicker(client, prompt);
          await poll(() => pickerState(client), (s) => s.noMatch && s.options.length === 0, "the freeform hint for a prompt no genie matches");
          await pressInPicker(client, "Enter");
          await poll(() => pickerState(client), (s) => s.confirmHint, "the second-Enter confirmation hint");
          await pressInPicker(client, "Enter");

          const editorHasAnswer = () => getEditorText(client).then((t) => typeof t === "string" && t.includes(answer));
          if (autoApprove) {
            ctx.log("advanced.mcpServer.autoApproveEdits is on — the answer is applied directly, with no preview");
          } else {
            const preview = await poll(
              () => pickerState(client),
              (s) => !s.open || s.canAccept || s.error !== null,
              "the picker to show the answer (or the provider's error)",
              { timeoutMs: RUN_TIMEOUT_MS, intervalMs: 250 }
            );
            if (!preview.open) throw new Error("the picker closed without a response: the run was refused before it reached the provider");
            if (preview.error !== null) throw new Error(`the run failed inside the app: ${preview.error}`);
            if (preview.response !== answer) throw new Error(`the preview shows ${JSON.stringify(preview.response)}, expected ${JSON.stringify(answer)}`);
            // A suggestion, not an edit: ghost text is painted and the word is still there.
            const pending = await evalJs(
              client,
              `(() => ({
                 ghost: document.querySelector('.ProseMirror .ai-suggestion-ghost')?.textContent ?? null,
                 original: document.querySelector('.ProseMirror')?.textContent.includes(${JSON.stringify(marker)}) ?? false,
               }))()`
            );
            if (pending.ghost !== answer || !pending.original) {
              throw new Error(`before Accept the editor should show the original word plus ghost text: ${JSON.stringify(pending)}`);
            }
            ctx.log("answer previewed in the picker and painted as ghost text; the document is unchanged");
            const clicked = await evalJs(
              client,
              `(() => { const b = document.querySelector('.genie-picker .genie-response-btn--accept'); if (!b) return false; b.click(); return true; })()`
            );
            if (!clicked) throw new Error("the Accept button vanished before it could be clicked");
          }

          await poll(editorHasAnswer, (v) => v === true, "the AI's text to land in the document", { timeoutMs: RUN_TIMEOUT_MS });
          const final = await evalJs(
            client,
            `(() => ({
               text: document.querySelector('.ProseMirror')?.textContent ?? null,
               ghosts: document.querySelectorAll('.ProseMirror .ai-suggestion-ghost').length,
               pickerOpen: !!document.querySelector('.genie-picker'),
             }))()`
          );
          if (!final.text?.includes(`alpha ${answer} omega`) || final.text.includes(marker) || final.ghosts !== 0 || final.pickerOpen) {
            throw new Error(`after Accept the document should read "alpha ${answer} omega" with no suggestion left: ${JSON.stringify(final)}`);
          }

          // Ground truth from the other side: exactly what Rust sent the provider.
          const sent = ollama.requests.filter((r) => r.method === "POST" && r.url === "/api/generate");
          const expectedPrompt = `${prompt}\n\n${marker}\n`;
          if (sent.length !== 1) {
            throw new Error(`expected ONE POST /api/generate, the stand-in saw: ${JSON.stringify(ollama.requests.map((r) => `${r.method} ${r.url}`))}`);
          }
          if (sent[0].body?.model !== "e2e-model" || sent[0].body?.stream !== false || sent[0].body?.prompt !== expectedPrompt) {
            throw new Error(`the provider request is not the selection-scoped prompt: ${JSON.stringify(sent[0].body)} (expected prompt ${JSON.stringify(expectedPrompt)})`);
          }
          ctx.log(`accepted: document reads "alpha ${answer} omega"; the provider received only the selected word`);
        } catch (err) {
          bodyError = err;
          throw err;
        } finally {
          await dismissPicker(client).catch((err) => ctx.log(`warning: ${err?.message ?? err}`));
          // Loud when the body succeeded: a provider store left pointing at a
          // dead loopback port is a silently reconfigured profile. When the
          // body failed, its error stays primary and this one is logged.
          try {
            const restored = await withAiStores(
              client,
              `(s) => {
                 const kept = window[${JSON.stringify(keep)}];
                 if (!kept) return "nothing-arranged";
                 s.useAiProviderStore.setState({ activeProvider: kept.activeProvider, restProviders: kept.restProviders });
                 s.usePromptHistoryStore.setState({ entries: kept.history });
                 delete window[${JSON.stringify(keep)}];
                 return "restored";
               }`
            );
            ctx.log(`provider store and prompt history: ${restored}`);
          } catch (restoreErr) {
            if (!bodyError) throw restoreErr;
            ctx.log(`warning: provider store restore failed after a body error: ${restoreErr?.message ?? restoreErr}`);
          }
        }
      });
    } finally {
      await ollama.close();
    }
  },
};
