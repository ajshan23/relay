import { env, type IdKind, idPrefixes, newId } from "@relay/core";
import { asc, createDb, eq, schema } from "@relay/db";
import { createEmailOutbox } from "@relay/email";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, organization } from "better-auth/plugins";
import { Redis } from "ioredis";

const config = env();
const { db } = createDb(config.DATABASE_URL);

/** Every email goes through @relay/email: logged in email_log, sent by the worker with retries. */
const emailOutbox = createEmailOutbox({
  db,
  connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
});

const dev = config.NODE_ENV !== "production";
const CODE_MINUTES = 10;
const RESET_MINUTES = 60;
const INVITATION_DAYS = 2;

const roleLabels: Record<string, string> = { owner: "an owner", admin: "an admin", member: "a team member" };

/**
 * Queue an email without making the request wait or fail on it. Not awaiting also keeps response
 * times the same whether or not an email was sent, so they reveal nothing about accounts.
 */
function queueInBackground(work: Promise<unknown>) {
  work.catch((err) => console.error("[email] could not queue", err));
}

/** Rules the web app shows next to the sign-up form; the auth config below enforces them. */
export const passwordMinLength = 10;

/** Google sign-in is offered only when both credentials are set. */
export const googleEnabled = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

/** Sign-in, sign-up and code endpoints: at most this many requests per window, per client IP and path. */
const strictLimit = { window: 60, max: 5 };

/**
 * Sign-in, sessions, organizations, members and invitations.
 * Branches and per-branch roles are ours (see modules/branches); Better Auth teams carry no role.
 *
 * The browser reaches this through the web app's /api rewrite, so the public origin is WEB_URL.
 */
export const auth = betterAuth({
  appName: "Relay",
  baseURL: config.WEB_URL,
  basePath: "/api/auth",
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [config.WEB_URL],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: passwordMinLength,
    // A new account cannot sign in until its email is confirmed with the 6-digit code.
    requireEmailVerification: true,
    resetPasswordTokenExpiresIn: RESET_MINUTES * 60,
    sendResetPassword: async ({ user, url }) => {
      queueInBackground(
        emailOutbox.queueEmail(
          "reset-password",
          user.email,
          { url, expiresInMinutes: RESET_MINUTES },
          { userId: user.id },
        ),
      );
    },
    // Signing up again with a registered email looks the same on screen (so nobody can learn who has
    // an account); the real owner gets this email telling them to sign in instead.
    onExistingUserSignUp: async ({ user }) => {
      queueInBackground(
        emailOutbox.queueEmail(
          "existing-account",
          user.email,
          { signInUrl: `${config.WEB_URL}/sign-in`, resetUrl: `${config.WEB_URL}/forgot-password` },
          { userId: user.id },
        ),
      );
    },
  },
  emailVerification: {
    // Signing in with the right password to an unverified account sends a fresh code, so the person can finish.
    sendOnSignIn: true,
    // Entering the right code signs the person in.
    autoSignInAfterVerification: true,
  },
  // Only added when configured. Google must have ${WEB_URL}/api/auth/callback/google as a redirect URI.
  ...(googleEnabled && {
    socialProviders: {
      google: {
        clientId: config.GOOGLE_CLIENT_ID as string,
        clientSecret: config.GOOGLE_CLIENT_SECRET as string,
      },
    },
  }),
  // Better Auth turns this on only in production by default; keep it on everywhere so it is exercised.
  // Memory storage is per process: move it to Redis or the database before running more than one API.
  rateLimit: {
    enabled: true,
    storage: "memory",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": strictLimit,
      "/sign-up/email": strictLimit,
      "/email-otp/*": strictLimit,
      "/request-password-reset": strictLimit,
    },
  },
  databaseHooks: {
    session: {
      create: {
        // New sessions land in the user's oldest organization membership, so sign-in opens an organization.
        before: async (session) => {
          const [first] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1);
          return { data: { ...session, activeOrganizationId: first?.organizationId ?? null } };
        },
      },
    },
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: CODE_MINUTES * 60,
      allowedAttempts: 5,
      sendVerificationOnSignUp: true,
      // Every verification email Better Auth sends (sign-up, sign-in when unverified) is a code, not a link.
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        // Handy while developing: the code is also in the API log. Never in production.
        if (dev) console.log(`[auth] email code for ${email} (${type}): ${otp}`);
        queueInBackground(
          emailOutbox.queueEmail("verify-code", email, {
            code: otp,
            purpose: type === "sign-in" ? "sign-in" : "sign-up",
            expiresInMinutes: CODE_MINUTES,
          }),
        );
      },
    }),
    organization({
      // Only people who confirmed their email (by code) can accept an invitation, and it must be
      // sent to that same email.
      requireEmailVerificationOnInvitation: true,
      invitationExpiresIn: INVITATION_DAYS * 24 * 60 * 60,
      sendInvitationEmail: async (data) => {
        const url = `${config.WEB_URL}/accept-invitation/${data.id}`;
        if (dev) console.log(`[auth] invitation for ${data.email} to ${data.organization.name}: ${url}`);
        queueInBackground(
          emailOutbox.queueEmail(
            "team-invitation",
            data.email,
            {
              inviterName: data.inviter.user.name,
              inviterEmail: data.inviter.user.email,
              organizationName: data.organization.name,
              roleLabel: roleLabels[data.role] ?? "a team member",
              url,
              expiresInDays: INVITATION_DAYS,
            },
            { organizationId: data.organization.id, userId: data.inviter.user.id },
          ),
        );
      },
    }),
  ],
  advanced: {
    ipAddress: {
      // Rate limits are per client IP. The web app's /api rewrite passes x-forwarded-for through as it
      // arrived and does not add one itself, so in production the proxy in front of the web app must
      // set it to the client address, replacing any value the client sent. Only a single address is
      // accepted; a missing header or a chain falls back to one bucket shared by everyone (development
      // falls back to 127.0.0.1).
      ipAddressHeaders: ["x-forwarded-for"],
    },
    database: {
      // Same readable, time-sortable IDs as the rest of the product.
      generateId: ({ model }) => (model in idPrefixes ? newId(model as IdKind) : newId("verification")),
    },
  },
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
