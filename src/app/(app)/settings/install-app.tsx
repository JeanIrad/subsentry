"use client";

import { Check, Download, Share, SquarePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { button } from "@/components/ui";

// Chrome/Android/desktop fire `beforeinstallprompt`; iOS Safari has no API,
// so we show the Share → Add to Home Screen steps instead.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Mode = "unknown" | "installed" | "prompt" | "ios" | "unsupported";

export function InstallApp() {
  const [mode, setMode] = useState<Mode>("unknown");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true);
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    // Deferred so the state update doesn't run synchronously inside the effect.
    queueMicrotask(() => setMode(standalone ? "installed" : ios ? "ios" : "unsupported"));

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("prompt");
    };
    const onInstalled = () => setMode("installed");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (mode === "installed") {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
        <Check className="size-4" /> Installed on this device
      </p>
    );
  }

  if (mode === "prompt" && deferred) {
    return (
      <button
        type="button"
        className={`${button.primary} w-full sm:w-auto`}
        onClick={async () => {
          await deferred.prompt();
          const { outcome } = await deferred.userChoice;
          if (outcome === "accepted") setMode("installed");
          setDeferred(null);
        }}
      >
        <Download className="size-4" /> Install SubSentry
      </button>
    );
  }

  if (mode === "ios") {
    return (
      <ol className="flex flex-col gap-2 text-sm">
        <li className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-brand-50 text-brand-600">
            <Share className="size-4" />
          </span>
          Tap <strong>Share</strong> in Safari&apos;s toolbar
        </li>
        <li className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-brand-50 text-brand-600">
            <SquarePlus className="size-4" />
          </span>
          Choose <strong>Add to Home Screen</strong>
        </li>
      </ol>
    );
  }

  return (
    <p className="text-sm text-muted">
      Open SubSentry in Chrome, Edge or Safari on your phone and use &ldquo;Add to Home Screen&rdquo; or
      &ldquo;Install app&rdquo;.
    </p>
  );
}
