import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { site } from "@/lib/site";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: { default: "PulseGrid — College Demo", template: "%s | PulseGrid College Demo" },
  description: `Centralized Cloud Blood Bank & Emergency Registry. Synthetic four-district Maharashtra pilot. ${site.disclaimer}`,
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg", apple: "/donor-192.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "PulseGrid Demo", statusBarStyle: "default" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const app = <AppShell>{children}</AppShell>;
  return <html lang="en"><body>{process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY ? <ClerkProvider>{app}</ClerkProvider> : app}</body></html>;
}
