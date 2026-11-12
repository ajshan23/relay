/** A Better Auth client error, as returned in `{ error }`. */
export type AuthClientError = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
} | null;

const plainMessages: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Wrong email or password. Try again.",
  INVALID_EMAIL: "That doesn't look like an email address.",
  USER_ALREADY_EXISTS: "There's already an account with this email. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "There's already an account with this email. Sign in instead.",
  PASSWORD_TOO_SHORT: "Use at least 10 characters for your password.",
  PASSWORD_TOO_LONG: "That password is too long.",
  EMAIL_NOT_VERIFIED: "Confirm your email address first, then sign in.",
  INVITATION_NOT_FOUND:
    "This invitation has expired or was already used. Ask the person who invited you to send a new one.",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "This invitation was sent to a different email address.",
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: "Confirm your email address before joining.",
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION:
    "The person who invited you is no longer on this team. Ask someone else to invite you.",
  ORGANIZATION_NOT_FOUND: "This business no longer exists.",
};

/** Turns a Better Auth error into a sentence a shop owner can act on. */
export function authErrorMessage(
  error: AuthClientError,
  fallback = "Something went wrong. Try again.",
): string {
  if (!error) return fallback;
  if (error.code && plainMessages[error.code]) return plainMessages[error.code];
  if (error.status === 429) return "Too many tries. Wait a minute and try again.";
  return fallback;
}

/**
 * Where to go after signing in. Only same-site paths are allowed ("/today", not
 * "//evil.example" or "https://…"), so a crafted link can't send people elsewhere.
 */
export function safeNext(value: string | null | undefined, fallback: string): string {
  return value && /^\/(?![/\\])/.test(value) ? value : fallback;
}

/** Adds `?next=` to a link when there is somewhere to come back to. */
export function withNext(href: string, next: string | null): string {
  return next ? `${href}?next=${encodeURIComponent(next)}` : href;
}
