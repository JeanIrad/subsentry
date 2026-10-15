"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { saveTimezone } from "./actions";

/** Stores the browser's IANA timezone on the user when it differs. Renders nothing. */
export function TimezoneSync({ current }: { current: string }) {
  const router = useRouter();
  useEffect(() => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz && browserTz !== current) {
      void saveTimezone(browserTz).then(() => router.refresh());
    }
  }, [current, router]);
  return null;
}
