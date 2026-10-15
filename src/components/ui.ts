// Shared class strings so buttons and cards look the same everywhere.

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60";

export const button = {
  primary: `${buttonBase} bg-brand-600 text-white shadow-lift hover:bg-brand-700`,
  secondary: `${buttonBase} border border-line bg-surface text-ink hover:border-brand-200 hover:bg-brand-50`,
  onBrand: `${buttonBase} bg-white text-brand-700 hover:bg-brand-50`,
  danger: `${buttonBase} border border-line bg-surface text-danger hover:bg-red-50`,
};

export const card = "rounded-2xl border border-line bg-surface shadow-card";
