import { Sidebar } from "@/components/sidebar";
import { authEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex h-full">
      <Sidebar authEnabled={authEnabled()} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
    </div>
  );
}
