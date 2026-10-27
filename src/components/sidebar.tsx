"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout, logoutAll } from "@/lib/actions";
import { IconCash, IconCrypto, IconFutures, IconHistory, IconHouse, IconLedger, IconLogout, IconOverview, IconPulse, IconStock } from "./icons";
import { Logo } from "./logo";

const NAV = [
  { href: "/", label: "總覽", icon: IconOverview },
  { href: "/stocks", label: "股票", icon: IconStock },
  { href: "/crypto", label: "加密貨幣", icon: IconCrypto },
  { href: "/futures", label: "期貨", icon: IconFutures },
  { href: "/cash", label: "現金", icon: IconCash },
  { href: "/real-estate", label: "房地產", icon: IconHouse },
  { href: "/history", label: "歷史快照", icon: IconHistory },
  // The phone's bottom bar is full; there it's reached from 股票, 加密貨幣 and 現金.
  { href: "/transactions", label: "交易紀錄", icon: IconLedger, desktopOnly: true },
];

export function Sidebar({ authEnabled, alertCount }: { authEnabled: boolean; alertCount: number }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-line bg-bg md:flex">
        <div className="flex h-12 items-center gap-2 px-4">
          <Logo size={18} />
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
        <div className="mt-auto flex flex-col gap-px px-2 pb-3">
          <Link
            href="/status"
            className={`flex h-7 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors ${
              isActive("/status") ? "bg-hover text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2"
            }`}
          >
            <IconPulse className={isActive("/status") ? "text-fg-2" : "text-fg-4"} />
            系統狀態
            {alertCount > 0 && (
              <span className="num ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">
                {alertCount}
              </span>
            )}
          </Link>
          {authEnabled && (
            <>
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
            </>
          )}
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.filter((n) => !n.desktopOnly).map(({ href, label, icon: Icon }) => (
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
