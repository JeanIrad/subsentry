"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { button } from "@/components/ui";
import { authClient } from "@/lib/auth/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.push("/");
        router.refresh();
      }}
      className={`${button.secondary} w-full sm:w-auto`}
    >
      <LogOut className="size-4" /> Sign out
    </button>
  );
}
