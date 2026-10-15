import { useId } from "react";

export function LogoMark({ className = "size-8" }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b6ef2" />
          <stop offset="1" stopColor="#1c41bd" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill={`url(#${id})`} />
      <path d="M50 18 76 28v20c0 16-11 28-26 34-15-6-26-18-26-34V28Z" fill="#fff" />
      <path
        d="m38.5 50 8 8 15-16"
        fill="none"
        stroke="#2453e0"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-lg font-bold tracking-tight">SubSentry</span>
    </span>
  );
}
