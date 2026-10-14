import { useId } from "react";

/** The app mark; same drawing as src/app/icon.svg and the PWA icons in public/icons. */
export function Logo({ size }: { size: number }) {
  // Gradient ids must be unique per instance, or a second logo on the page would reuse the first one's.
  const id = useId();
  const bg = `${id}-bg`;
  const area = `${id}-area`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7480e8" />
          <stop offset="1" stopColor="#4a53b8" />
        </linearGradient>
        <linearGradient id={area} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".28" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22" fill={`url(#${bg})`} />
      <path d="M24 66 L42 46 L55 56 L76 32 L76 76 L24 76 Z" fill={`url(#${area})`} />
      <path d="M24 66 L42 46 L55 56 L76 32" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="76" cy="32" r="6.5" fill="#fff" />
    </svg>
  );
}
