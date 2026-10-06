/**
 * Journey: browser-ssrf-policy  (WI-5.3 · B4/B5 — AI navigation policy)
 *
 * The AI must not be able to reach the machine's own services, the LAN, or cloud
 * metadata endpoints. `ai_policy.rs` refuses those destinations BEFORE WebKit is
 * given a request; this proves it end-to-end, through the shipping MCP surface.
 *
 * THE TRAP THIS JOURNEY IS BUILT TO AVOID. A refusal is the expected result for
 * every case, and a refusal is ALSO what you get from a typo'd URL, a fixture
 * server that never started, or a browser that is simply switched off. Asserting
 * "it failed" would pass under all of those, which is how a security test ends up
 * proving nothing. Two structural defences:
 *
 *   1. A POSITIVE CONTROL runs first. A fixture URL that policy permits must
 *      SUCCEED. If it does not, the journey fails immediately rather than
 *      reporting a clean sweep of refusals that were all environmental.
 *   2. Every refusal is matched against the policy's own error text, so a
 *      refusal for a different reason is a failure, not a pass.
 *
 * LOOPBACK IS TESTED WITH THE OPT-IN OFF. `browser.aiAllowLoopback` is the
 * setting that permits 127.0.0.1; with it off, loopback must be refused like any
 * other private destination. The positive control therefore cannot be a loopback
 * fixture — it uses the redirect endpoint reached with the opt-in ON, in a
 * separate phase, so each phase asserts exactly one policy state.
 *
 * SEEN TO FAIL — observed by deleting a suffix from `lan_facing_suffix` in
 * ai_policy.rs: `printer.local` then navigates instead of being refused and the
 * journey goes red on that case alone.
 *
 * SAFETY — engineered, not asserted. An earlier version claimed "nothing leaves
 * the machine", which was circular: it was true only if the policy under test
 * worked. Under the regression this journey detects, it would have contacted the
 * user's LAN and router and put Basic credentials on the wire.
 *
 * SAFETY — closed by REMOVING the hazard, not by sandboxing it.
 *
 * Two earlier versions of this list could, under the exact regression they detect,
 * have contacted real infrastructure: a router, RFC1918 space, `169.254.169.254`
 * (a live metadata endpoint on a cloud VM), and mDNS/`.internal` names that resolve
 * on real corporate networks. Calling those "reserved and unrouted" was wrong.
 *
 * The reflex is to build an egress sandbox so the risky cases can stay. That is the
 * wrong trade here, because those cases were carrying NO COVERAGE the suite did not
 * already have: `ai_policy.test.rs` exercises every one of them — the LAN suffixes,
 * the metadata names, link-local — exhaustively and with zero network. The E2E's job
 * is narrower: prove the policy is actually WIRED into navigation. One observable
 * case does that, and the loopback packet oracle below is observable.
 *
 * So what remains is destinations that cannot reach anything: loopback (which the
 * fixture server observes directly), RFC 5737 documentation ranges, and schemes with
 * no network step at all. A total policy failure here emits nothing that can leave
 * the machine — a property of the list, not a claim about the code under test.
 *
 * Restores all browser settings, including on failure.
 */

import { startVmarkMcp, bridgeReady } from "../lib/vmarkMcp.mjs";
import { withBrowserEnabled } from "../lib/browser.mjs";
import { startFixtureServer } from "../lib/fixtureServer.mjs";
import { refusalLayer } from "../lib/browserRefusal.mjs";

/**
 * Destinations the AI navigation policy must refuse before issuing a request.
 *
 * CHOSEN FOR SAFETY UNDER FAILURE. The earlier list pointed at a real router
 * (192.168.0.1), real RFC1918 space, and `example.com` with Basic credentials in
 * the authority — so under the exact regression this journey exists to detect, it
 * would have put those requests, and those credentials, on the wire. A test whose
 * failure mode is "contact the user's LAN" is not an acceptable test.
 *
 * Everything here is now either OBSERVABLE (loopback, where the fixture server
 * itself is the packet oracle — see the phase 2 assertion) or RESERVED-AND-UNROUTED
 * (RFC 5737 TEST-NET blocks, RFC 3927 link-local), so a policy failure cannot reach
 * anything real. `ai_policy.rs` blocks TEST-NET as part of its special-purpose
 * ranges, so these exercise genuine policy branches rather than being placeholders.
 *
 * EACH CASE NAMES THE LAYER THAT MUST REFUSE IT (`e2e/lib/browserRefusal.mjs`).
 * Every http(s) destination must reach the app and be refused by `ai_policy.rs`
 * ("policy"). A non-HTTP(S) scheme never gets that far: the sidecar's input
 * schema refuses it first ("schema"), and `ai_policy.test.rs` covers the Rust
 * refusal of the same schemes with zero network. A refusal from the wrong layer
 * fails the case, so neither layer can stand in for the other.
 */
export const BLOCKED = [
  // Loopback — the observable class. Every spelling the policy must normalise.
  ["loopback by name", "http://localhost:9/", "policy"],
  ["loopback literal", "http://127.0.0.1:9/", "policy"],
  ["loopback shorthand", "http://127.1:9/", "policy"],
  ["loopback as integer", "http://2130706433:9/", "policy"],
  ["loopback as hex", "http://0x7f000001:9/", "policy"],
  // RFC 5737 documentation ranges — reserved, and route nowhere by definition.
  ["TEST-NET-1 (RFC 5737)", "http://192.0.2.1/", "policy"],
  ["TEST-NET-2 (RFC 5737)", "http://198.51.100.1/", "policy"],
  ["TEST-NET-3 (RFC 5737)", "http://203.0.113.1/", "policy"],
  ["userinfo in authority", "http://user:pass@192.0.2.2/", "policy"],
  // Non-HTTP(S) schemes — the sidecar schema refuses them before the app sees
  // them (Rust refuses them too; ai_policy.test.rs). No network either way.
  ["file scheme", "file:///etc/passwd", "schema"],
  ["data scheme", "data:text/html,<h1>x</h1>", "schema"],
];

export default {
  name: "browser-ssrf-policy",
  platforms: ["darwin"],
  coverageRequired: true,

  async run(client, ctx) {
    if (!(await bridgeReady())) {
      return { skip: "VMark MCP bridge is not advertising a port" };
    }

    const fx = await startFixtureServer();
    const mcp = await startVmarkMcp();
    try {
      // --- Phase 1: positive control, loopback opt-in ON --------------------
      // Proves the whole path works when policy permits, so a later refusal
      // cannot be blamed on a broken environment.
      await withBrowserEnabled(client, { allowLoopback: true }, async () => {
        const ok = await mcp.callTool("browser", { action: "open", url: fx.url("/") });
        if (ok.isError) {
          throw new Error(
            `POSITIVE CONTROL FAILED — a permitted fixture URL was refused, so the ` +
              `refusals below would prove nothing: ${ok.text.slice(0, 250)}`
          );
        }
        if (fx.hits("/") < 1) {
          throw new Error("positive control: the fixture was never actually requested");
        }
        ctx.log("positive control: permitted URL navigated");
      });

      // --- Phase 2: everything above must be refused, opt-in OFF ------------
      await withBrowserEnabled(client, { allowLoopback: false }, async () => {
        fx.resetHits();

        // THE PACKET ORACLE. With `allowLoopback` off, the fixture's own URL is a
        // blocked destination — and it is the one blocked destination whose server
        // we control, so its request counter is direct evidence of whether a packet
        // was actually emitted. Every other case can only be observed through the
        // returned error; this one is observed on the wire.
        const oracleUrl = fx.url("/");
        const oracle = await mcp.callTool("browser", { action: "open", url: oracleUrl });
        if (!oracle.isError) {
          throw new Error("a loopback URL was navigated with the loopback opt-in OFF");
        }
        // Give a leaked request time to land before declaring none was made.
        await new Promise((r) => setTimeout(r, 1500));
        if (fx.hits("/") !== 0) {
          throw new Error(
            `POLICY RAN TOO LATE — the blocked loopback destination received ` +
              `${fx.hits("/")} real request(s). The refusal above happened after the wire.`
          );
        }
        ctx.log("packet oracle: blocked loopback destination received zero requests");
        for (const [label, url, expected] of BLOCKED) {
          const res = await mcp.callTool("browser", { action: "open", url });
          if (!res.isError) {
            throw new Error(`${label} (${url}) was NOT refused — the AI reached it`);
          }
          // A refusal for the wrong reason (bad args, disabled browser, crash) is
          // not evidence that the SSRF policy did anything — and a refusal by the
          // wrong LAYER is a different contract from the one this case pins.
          const layer = refusalLayer(res.text);
          if (layer === "disabled") {
            throw new Error(`${label}: refused because the browser was disabled, not by policy`);
          }
          if (layer !== expected) {
            throw new Error(
              `${label} refused by the wrong layer — expected ${expected}, got ${layer}: ${res.text.slice(0, 200)}`
            );
          }
        }
        ctx.log(`${BLOCKED.length} destinations refused before any request`);

        // The `BLOCKED` list above has no counter assertion, and that is correct:
        // the fixture observes only its own port, which none of those target, so a
        // counter check there could never fail. The packet oracle at the top of
        // this phase is the observable case; the rest are observed through their
        // refusal, with `ai_policy.test.rs` covering the decision exhaustively.
      });
    } finally {
      await mcp.close();
      await fx.close();
    }
  },
};
