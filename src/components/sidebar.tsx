"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout, logoutAll } from "@/lib/actions";
import { IconCash, IconCrypto, IconFutures, IconHistory, IconHouse, IconLogout, IconOverview, IconStock } from "./icons";

const NAV = [
  { href: "/", label: "總覽", icon: IconOverview },
  { href: "/stocks", label: "股票", icon: IconStock },
  { href: "/crypto", label: "加密貨幣", icon: IconCrypto },
  { href: "/futures", label: "期貨", icon: IconFutures },
  { href: "/cash", label: "現金", icon: IconCash },
  { href: "/real-estate", label: "房地產", icon: IconHouse },
  { href: "/history", label: "歷史快照", icon: IconHistory },
];

export function Sidebar({ authEnabled }: { authEnabled: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-line bg-bg md:flex">
        <div className="flex h-12 items-center gap-2 px-4">
          <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path d="M9 21l5-6 4 3 5-7" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[13px] font-medium">Assets</span>
        </div>
        <nav className="flex flex-col gap-px px-2 pt-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`flex h-7 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors ${
                isActive(href) ? "bg-hover text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2"
              }`}
            >
              <Icon className={isActive(href) ? "text-fg-2" : "text-fg-4"} />
              {label}
            </Link>
          ))}
        </nav>
        {authEnabled && (
          <div className="mt-auto flex flex-col gap-px px-2 pb-3">
            <form action={logout}>
              <button className="flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-4 hover:bg-hover hover:text-fg-2">
                <IconLogout />
                登出
              </button>
            </form>
            <form
              action={logoutAll}
              onSubmit={(e) => {
                if (!confirm("確定要登出所有裝置（包含這台）嗎？")) e.preventDefault();
              }}
            >
              <button className="flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-[12px] text-fg-4 hover:bg-hover hover:text-fg-2">
                <span className="w-4" />
                登出所有裝置
              </button>
            </form>
          </div>
        )}
      </aside>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-bg/95 backdrop-blur md:hidden">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${isActive(href) ? "text-fg" : "text-fg-4"}`}
          >
            <Icon />
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}
