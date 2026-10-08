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
  const units = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${sym}${units.toLocaleString('en-GB')}.${frac}`;
}
