import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/*
 * One admin password (KAIROS_ADMIN_PASSWORD). Signing in sets an HMAC-signed cookie with an expiry;
 * changing the password signs everyone out.
 */
const COOKIE = "kairos_session";
const DAYS = 7;

function secret() {
  const pw = process.env.KAIROS_ADMIN_PASSWORD;
  return pw ? `kairos-dashboard:${pw}` : null;
}

function sign(value: string, key: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export function passwordConfigured() {
  return !!secret();
}

export function checkPassword(input: string) {
  const pw = process.env.KAIROS_ADMIN_PASSWORD;
  if (!pw) return false;
  const a = Buffer.from(sign(input, "cmp"));
  const b = Buffer.from(sign(pw, "cmp"));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startSession() {
  const key = secret();
  if (!key) return;
  const expires = Date.now() + DAYS * 86_400_000;
  const value = `${expires}.${sign(String(expires), key)}`;
  (await cookies()).set(COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expires),
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function signedIn() {
  const key = secret();
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!key || !raw) return false;
  const [expires, mac] = raw.split(".");
  if (!expires || !mac || Number(expires) < Date.now()) return false;
  const want = Buffer.from(sign(expires, key));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function requireSignIn() {
  if (!(await signedIn())) redirect("/login");
}
