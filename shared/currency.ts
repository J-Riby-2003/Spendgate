// Fiat assets supported by this runtime's ICU data. Asset precision is explicit
// at the boundary; token assets must have their own namespace in a future integration.
export const CURRENCIES: readonly string[] = Intl.supportedValuesOf('currency');
export function currencyPrecision(currency: string): number {
  if (!CURRENCIES.includes(currency)) throw new Error(`Unsupported currency: ${currency}`);
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!;
}
export function isSupportedCurrency(currency: string): boolean { return CURRENCIES.includes(currency); }
/** Exact decimal input: reject fractional atomic units rather than rounding them. */
export function parseMinor(units: string, currency: string): number | null {
  if (!isSupportedCurrency(currency)) return null;
  const value = units.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(value) || value.length > 32) return null;
  const precision = currencyPrecision(currency);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > precision) return null;
  const amount = BigInt(whole || '0') * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0') || '0');
  return amount <= 1000000000000n ? Number(amount) : null;
}
