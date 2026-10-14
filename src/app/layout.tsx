import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ServiceWorker } from "@/components/service-worker";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Assets",
  description: "個人資產儀表板",
  // iOS ignores the manifest for these; apple-icon.png next to this file supplies the home-screen icon.
  appleWebApp: { capable: true, title: "Assets", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  // Draw under the iPhone notch / home indicator; PageHeader and the bottom nav pad by the safe-area insets.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090a" },
    { media: "(prefers-color-scheme: light)", color: "#f7f8f8" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-Hant-TW" className={`${inter.variable} h-full`}>
      <body className="h-full">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
