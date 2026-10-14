import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Personal dashboard: every page reads live data from SQLite, so render dynamically.
  cacheComponents: false,
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    // Browsers re-check the service worker on every navigation; never let a cache pin an old one.
    return [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] }];
  },
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
