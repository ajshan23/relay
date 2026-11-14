/**
 * The public website (relay-site, a separate repo): landing page, Terms, Privacy, Data deletion.
 * Set NEXT_PUBLIC_SITE_URL to its hosted address.
 */
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3300").replace(/\/$/, "");
