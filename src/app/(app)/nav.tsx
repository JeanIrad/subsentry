"use client";

import { House, ListChecks, Settings, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/dashboard", label: "Home", icon: House },
  { href: "/subscriptions", label: "Subscriptions", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
];

type IsActive = (href: string) => boolean;
const none: IsActive = () => false;

// The pathname is request data, so (with cacheComponents) it must be read
// inside <Suspense>: the tabs render immediately, the highlight streams in.
function WithPathname({ render }: { render: (isActive: IsActive) => ReactNode }) {
  const pathname = usePathname();
  return render((href) => pathname === href || pathname.startsWith(`${href}/`));
}

export function TopNav() {
  return (
    <Suspense fallback={<TopNavView isActive={none} />}>
      <WithPathname render={(isActive) => <TopNavView isActive={isActive} />} />
    </Suspense>
  );
}

export function BottomTabs() {
  return (
    <Suspense fallback={<BottomTabsView isActive={none} />}>
      <WithPathname render={(isActive) => <BottomTabsView isActive={isActive} />} />
    </Suspense>
  );
}

function TopNavView({ isActive }: { isActive: IsActive }) {
  return (
    <nav className="hidden gap-1 sm:flex" aria-label="Main">
      {TABS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href) ? "page" : undefined}
          className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
            isActive(href) ? "bg-brand-50 text-brand-700" : "text-muted hover:bg-canvas hover:text-ink"
          }`}
        >
          <Icon className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function BottomTabsView({ isActive }: { isActive: IsActive }) {
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 backdrop-blur-md sm:hidden"
    >
      <ul className="mx-auto flex max-w-md">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold ${
                  active ? "text-brand-600" : "text-muted"
                }`}
              >
                <span className={`grid h-7 w-14 place-items-center rounded-full transition ${active ? "bg-brand-50" : ""}`}>
                  <Icon className="size-[22px]" strokeWidth={active ? 2.4 : 2} />
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
