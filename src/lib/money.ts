// All money in the app is integer minor units + ISO 4217 currency.
// Conversion from the LLM's major-unit floats happens once, via toMinorUnits.

const exponentCache = new Map<string, number>();

/** Number of minor-unit digits for a currency: USD 2, JPY 0, KWD 3. */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  const cached = exponentCache.get(code);
  if (cached !== undefined) return cached;
  if (!isSupportedCurrency(code)) throw new RangeError(`Unknown currency: ${currency}`);
  const exp = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
    .maximumFractionDigits;
  if (exp === undefined) throw new RangeError(`No minor unit for currency: ${currency}`);
  exponentCache.set(code, exp);
  return exp;
}

export function isSupportedCurrency(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency) && Intl.supportedValuesOf("currency").includes(currency);
}

/** 11.99 USD → 1199; 1500 JPY → 1500; 1.234 KWD → 1234. */
export function toMinorUnits(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) throw new RangeError(`Invalid amount: ${amount}`);
  const scaled = amount * 10 ** currencyExponent(currency);
  // toPrecision strips binary float noise (1.005 * 100 = 100.49999…) before rounding.
  const minor = Math.round(Number(scaled.toPrecision(15)));
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Amount out of range: ${amount}`);
  return minor;
}

export function formatMoney(amountMinor: number, currency: string, locale = "en-US"): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(
    amountMinor / 10 ** exp,
  );
}
