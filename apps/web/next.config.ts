import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@relay/ui", "@relay/core"],
  // The browser talks to the API through the web app's own origin, so sign-in cookies are first-party.
  async rewrites() {
    const api = process.env.API_URL ?? "http://localhost:3201";
    // Live update streams have their own process (apps/api/src/realtime.ts); first match wins.
    const realtime = process.env.REALTIME_URL ?? "http://localhost:3203";
    return [
      { source: "/api/events", destination: `${realtime}/api/events` },
      { source: "/api/events/:path*", destination: `${realtime}/api/events/:path*` },
      { source: "/api/:path*", destination: `${api}/api/:path*` },
    ];
  },
  // Next's development badge covers the account menu, panel close buttons or the ask bar in every corner.
  devIndicators: false,
  cacheComponents: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
