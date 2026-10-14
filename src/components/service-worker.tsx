"use client";

import { useEffect } from "react";

/** Registers public/sw.js (offline fallback only). Skipped in dev so it never fights hot reload. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* unsupported or blocked; the app works the same without it */
    });
  }, []);
  return null;
}
