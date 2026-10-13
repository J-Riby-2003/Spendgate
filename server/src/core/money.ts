import { currencyPrecision, isSupportedCurrency } from '../../../shared/currency.js';
// Money is integer minor units everywhere; this formats for humans.
const SYMBOLS: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

export function formatMinor(amount: number, currency: string): string {
  const sym = SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const sign = amount < 0 ? '−' : '';
  const abs = Math.abs(amount);
  // Unsupported historical assets are displayed as raw atomic units, never reinterpreted.
  if (!isSupportedCurrency(currency.toUpperCase())) return `${amount} ${currency} atomic units`;
  const precision = currencyPrecision(currency.toUpperCase()), scale = 10 ** precision;
  const units = Math.floor(abs / scale);
  const frac = String(abs % scale).padStart(precision, '0');
  return `${sign}${sym}${units.toLocaleString('en-GB')}${precision ? `.${frac}` : ''}`;
}
