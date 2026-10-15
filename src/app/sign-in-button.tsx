"use client";

import { useState } from "react";
import { GoogleIcon } from "@/components/google-icon";
import { button } from "@/components/ui";
import { authClient } from "@/lib/auth/client";

export function SignInButton({ variant = "onBrand" }: { variant?: keyof typeof button }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
    if (error) {
      setError(error.message ?? "Sign-in failed. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-start">
      <button type="button" onClick={signIn} disabled={pending} className={`${button[variant]} w-full sm:w-auto`}>
        <span className="grid size-6 place-items-center rounded-full bg-white">
          <GoogleIcon className="size-4" />
        </span>
        {pending ? "Opening Google…" : "Continue with Google"}
      </button>
      {error && (
        <p role="alert" className="text-sm font-medium text-red-100">
          {error}
        </p>
      )}
    </div>
  );
}
