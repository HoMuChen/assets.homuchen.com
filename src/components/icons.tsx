import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const IconOverview = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>
);
export const IconCash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="1.5" y="4" width="13" height="8.5" rx="1.5" /><circle cx="8" cy="8.25" r="1.75" /><path d="M4 6.5v3.5M12 6.5v3.5" /></svg>
);
export const IconStock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 12.5l3.5-4 3 2.5 5.5-7" /><path d="M10.5 4H14v3.5" /></svg>
);
export const IconCrypto = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="8" cy="8" r="6.25" /><path d="M6.5 5h2.25a1.5 1.5 0 010 3H6.5h2.75a1.5 1.5 0 010 3H6.5V5zM7.5 4v1M7.5 11v1" /></svg>
);
export const IconFutures = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2.5 13.5h11" /><path d="M4.5 11V7.5M8 11V4.5M11.5 11V6" /><path d="M3.5 7.5h2M7 4.5h2M10.5 6h2" /></svg>
);
export const IconHouse = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2.5 7L8 2.5 13.5 7v6.5h-11V7z" /><path d="M6.5 13.5V10h3v3.5" /></svg>
);
export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2.5 8a5.5 5.5 0 105.5-5.5A5.5 5.5 0 004 4.3" /><path d="M2.5 2v2.5H5" /><path d="M8 5v3l2 1.5" /></svg>
);
export const IconPulse = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M1.5 8.5h3l1.75-4.5 3.25 8 1.75-3.5h3.25" /></svg>
);
export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M13 8a5 5 0 11-1.46-3.54" /><path d="M13 2.5v3h-3" /></svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 3v10M3 8h10" /></svg>
);
export const IconCamera = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 5.5A1.5 1.5 0 013.5 4h1.75L6.5 2.5h3L10.75 4h1.75A1.5 1.5 0 0114 5.5v6A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-6z" /><circle cx="8" cy="8.5" r="2.25" /></svg>
);
export const IconLogout = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 2.5H3.5a1 1 0 00-1 1v9a1 1 0 001 1H6M10.5 11l3-3-3-3M13.5 8H6" /></svg>
);
export const IconLedger = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="2.5" y="1.75" width="11" height="12.5" rx="1.5" /><path d="M5 5h6M5 8h6M5 11h3.5" /></svg>
);
