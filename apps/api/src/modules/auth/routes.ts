import { Hono } from "hono";
import { googleEnabled, passwordMinLength } from "./auth";

/** What the sign-in and sign-up screens may offer. Public: it is read before anyone signs in. */
export function authOptionsRoutes() {
  const app = new Hono();

  app.get("/", (c) => c.json({ google: googleEnabled, emailVerification: true, passwordMinLength }));

  return app;
}
