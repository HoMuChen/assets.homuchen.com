import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Personal dashboard: every page reads live data from SQLite, so render dynamically.
  cacheComponents: false,
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
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
