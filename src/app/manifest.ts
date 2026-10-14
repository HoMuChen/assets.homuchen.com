import type { MetadataRoute } from "next";

/** Served at /manifest.webmanifest; listed as public in src/proxy.ts so installs work before login. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Assets 資產儀表板",
    short_name: "Assets",
    description: "個人資產儀表板",
    lang: "zh-Hant-TW",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#08090a",
    theme_color: "#08090a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
