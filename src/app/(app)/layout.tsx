import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { BottomTabs, TopNav } from "./nav";

// Signed-in app shell: top bar everywhere, tab bar at the bottom on phones.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
          <Link href="/dashboard" aria-label="SubSentry home">
            <Logo />
          </Link>
          <TopNav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-28 sm:px-5 sm:pb-12">{children}</main>
      <BottomTabs />
    </div>
  );
}
