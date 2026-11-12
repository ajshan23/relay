import { createMiddleware } from "hono/factory";
import { auth, type Session } from "./auth";

export type AuthEnv = {
  Variables: {
    user: Session["user"];
    session: Session["session"];
  };
};

/** Rejects the request with 401 unless it carries a valid session; puts the user and session on the context. */
export const requireSession = createMiddleware<AuthEnv>(async (c, next) => {
  const current = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!current) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", current.user);
  c.set("session", current.session);
  await next();
});
