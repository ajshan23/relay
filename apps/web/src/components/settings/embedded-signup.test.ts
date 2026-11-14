import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readSignupMessage,
  runSignup,
  type SignupDeps,
  SignupStopped,
  trustedOrigin,
} from "./embedded-signup";

const FB = "https://www.facebook.com";
const finish = (data: Record<string, unknown>, event = "FINISH") =>
  JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data });

/** A fake popup: lets a test deliver the login callback and messages in any order, with a manual clock. */
function harness() {
  let handler: ((e: { origin: string; data: unknown }) => void) | null = null;
  let callback: ((res: { authResponse?: { code?: string } | null }) => void) | null = null;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const deps: SignupDeps = {
    login: (cb) => {
      callback = cb;
    },
    listen: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clear: (t) => {
      (t as { live: boolean }).live = false;
    },
  };
  return {
    deps,
    message: (data: unknown, origin = FB) => handler?.({ origin, data }),
    code: (code: string | null) => callback?.({ authResponse: code ? { code } : null }),
    fire: (ms: number) => {
      for (const t of timers) if (t.live && t.ms === ms) t.fn();
    },
    listening: () => handler !== null,
  };
}

describe("Embedded Signup popup", () => {
  it("trusts only https facebook.com and its subdomains", () => {
    assert.ok(trustedOrigin("https://www.facebook.com"));
    assert.ok(trustedOrigin("https://web.facebook.com"));
    assert.ok(trustedOrigin("https://facebook.com"));
    assert.ok(!trustedOrigin("https://evil-facebook.com"));
    assert.ok(!trustedOrigin("http://www.facebook.com"));
    assert.ok(!trustedOrigin("https://www.facebook.com:8443"));
    assert.ok(!trustedOrigin("not a url"));
  });

  it("reads the v5 payload (messaging_account_ids, is_on_biz_app) and the older waba_id", () => {
    const v5 = readSignupMessage(
      FB,
      finish({
        phone_number_id: "11",
        messaging_account_ids: ["22"],
        business_id: "33",
        is_on_biz_app: false,
      }),
    );
    assert.deepEqual(v5, {
      type: "finish",
      session: {
        event: "FINISH",
        phoneNumberId: "11",
        messagingAccountIds: ["22"],
        businessId: "33",
        isOnBizApp: false,
      },
    });
    const coex = readSignupMessage(
      FB,
      finish({ messaging_account_ids: ["22"] }, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"),
    );
    assert.equal(coex?.type === "finish" && coex.session.isOnBizApp, true);
    const v4 = readSignupMessage(FB, {
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { waba_id: "44", phone_number_id: "11" },
    });
    assert.deepEqual(v4?.type === "finish" && v4.session.messagingAccountIds, ["44"]);
  });

  it("maps cancel, cancel-with-error, error and waba-only, and ignores other messages", () => {
    assert.deepEqual(readSignupMessage(FB, finish({ current_step: "PHONE" }, "CANCEL")), { type: "cancel" });
    assert.deepEqual(readSignupMessage(FB, finish({ error_message: "Blocked" }, "CANCEL")), {
      type: "error",
      message: "Blocked",
    });
    assert.deepEqual(readSignupMessage(FB, finish({ error_message: "Boom" }, "ERROR")), {
      type: "error",
      message: "Boom",
    });
    assert.deepEqual(readSignupMessage(FB, finish({}, "FINISH_ONLY_WABA")), { type: "no_number" });
    assert.equal(readSignupMessage("https://evil.example", finish({})), null);
    assert.equal(readSignupMessage(FB, "{not json"), null);
    assert.equal(readSignupMessage(FB, JSON.stringify({ type: "OTHER" })), null);
  });

  it("resolves when the session comes before the code", async () => {
    const h = harness();
    const p = runSignup(h.deps);
    h.message(finish({ phone_number_id: "11", messaging_account_ids: ["22"] }));
    h.code("CODE1");
    const out = await p;
    assert.equal(out.code, "CODE1");
    assert.equal(out.session.phoneNumberId, "11");
    assert.equal(h.listening(), false);
  });

  it("resolves when the code comes before the session", async () => {
    const h = harness();
    const p = runSignup(h.deps);
    h.code("CODE2");
    h.message(
      finish(
        { phone_number_id: "11", messaging_account_ids: ["22"] },
        "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      ),
    );
    const out = await p;
    assert.equal(out.session.event, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
  });

  it("goes with the code alone if the session never arrives (the server finds the ids)", async () => {
    const h = harness();
    const p = runSignup(h.deps);
    h.code("CODE3");
    h.fire(5_000);
    assert.deepEqual(await p, { code: "CODE3", session: {} });
  });

  it("keeps the first finish", async () => {
    const h = harness();
    const p = runSignup(h.deps);
    h.message(finish({ messaging_account_ids: ["1"] }, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"));
    h.message(finish({ messaging_account_ids: ["2"] }));
    h.code("C");
    assert.deepEqual((await p).session.messagingAccountIds, ["1"]);
  });

  it("rejects on cancel, error, no number, a closed window and a deadline", async () => {
    const cases: [(h: ReturnType<typeof harness>) => void, SignupStopped["kind"]][] = [
      [(h) => h.message(finish({}, "CANCEL")), "cancelled"],
      [(h) => h.message(finish({ error_message: "x" }, "ERROR")), "error"],
      [(h) => h.message(finish({}, "FINISH_ONLY_WABA")), "error"],
      [(h) => h.code(null), "cancelled"],
      [(h) => h.fire(15 * 60_000), "error"],
    ];
    for (const [act, kind] of cases) {
      const h = harness();
      const p = runSignup(h.deps);
      act(h);
      await assert.rejects(p, (err: unknown) => err instanceof SignupStopped && err.kind === kind);
      assert.equal(h.listening(), false);
    }
  });

  it("rejects clearly when the popup can't open", async () => {
    const h = harness();
    const p = runSignup({
      ...h.deps,
      login: () => {
        throw new Error("FB is not defined");
      },
    });
    await assert.rejects(p, /pop-ups/);
  });
});
