"use client";

import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Sign-in, email codes, sessions, organizations, members and invitations, from the browser.
 * Requests go to this app's own /api/auth, which is proxied to the API server.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient(), emailOTPClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
