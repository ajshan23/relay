import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().default(3201),
  WEB_URL: z.string().url().default("http://localhost:3200"),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Google sign-in is offered only when both are set (empty counts as unset).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Email goes out through Resend when the key is set; without it, emails are printed to the API log.
  RESEND_API_KEY: z.string().optional(),
  // Must be on a domain verified in Resend. onboarding@resend.dev only delivers to the Resend account's own email.
  EMAIL_FROM: z.string().default("Relay <onboarding@resend.dev>"),
  EMAIL_REPLY_TO: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated server environment. Throws at startup if a variable is missing or malformed. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
