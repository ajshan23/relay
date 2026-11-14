import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().default(3201),
  /** Live updates (/api/events) run in their own process: apps/api/src/realtime.ts. */
  REALTIME_PORT: z.coerce.number().default(3203),
  /** Address the API, realtime and worker health servers listen on. On a server, 127.0.0.1 so only nginx reaches them. */
  HOST: z.string().default("0.0.0.0"),
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
  // Meta (WhatsApp, Instagram, Messenger). The app secret signs every webhook; the verify token is
  // the string entered in the Meta app's webhook settings.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  // Pinned Graph API version. Override the base URL only to point tests at a fake Graph server.
  META_GRAPH_VERSION: z.string().default("v26.0"),
  META_GRAPH_URL: z.string().url().default("https://graph.facebook.com"),
  // How long to wait for Meta before treating a send as uncertain (never resent blindly).
  META_GRAPH_TIMEOUT_MS: z.coerce.number().default(15_000),
  // 32 bytes, base64 (openssl rand -base64 32). Encrypts channel access tokens in the database.
  CHANNEL_SECRET_KEY: z.string().optional(),
  // Files on local disk, when S3 isn't set up (tests, offline work). See storage.ts.
  MEDIA_DIR: z.string().default(".data/media"),
  /** Files go to S3 when a bucket is set (see storage.ts); "local" forces the disk. */
  STORAGE_DRIVER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["s3", "local"]).optional()),
  S3_BUCKET: z.string().optional(),
  // Falls back to AWS_REGION, then ap-south-1.
  S3_REGION: z.string().optional(),
  AWS_REGION: z.string().optional(),
  /**
   * An S3-compatible service instead of AWS itself (Neon storage, Cloudflare R2, MinIO), e.g.
   * "https://<project>.storage.neon.tech". AWS_ENDPOINT_URL_S3 is read too, as the AWS tools do.
   */
  S3_ENDPOINT: z.string().url().optional(),
  AWS_ENDPOINT_URL_S3: z.string().url().optional(),
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
