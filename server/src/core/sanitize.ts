// Input guards shared by every SpendGate surface (REST + MCP).
// Rules: no NUL/control characters, trimmed, length-capped,
// and money is always a bounded non-negative integer in minor units.

export class InputError extends Error { readonly status = 422; }

/** Strip NUL + control chars, trim, enforce max length. Returns null when optional and absent/empty. */
export function cleanStr(v: unknown, name: string, max: number, optional = false): string | null {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new InputError(`${name} is required.`);
  }
  if (typeof v !== 'string') throw new InputError(`${name} must be a string.`);
  const s = v.replace(/[\0-\x1F\x7F]/g, '').trim();
  if (!s) {
    if (optional) return null;
    throw new InputError(`${name} must not be empty.`);
  }
  if (s.length > max) throw new InputError(`${name} is too long (max ${max} characters).`);
  return s;
}

/** Minor-unit money: null / '' / undefined = unlimited; otherwise integer 0..1e12 (10 billion major units). */
export function cleanMinor(v: unknown, name: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new InputError(`${name} must be a non-negative whole number.`);
  }
  if (n > 1e12) throw new InputError(`${name} is too large (max 10,000,000,000.00).`);
  return n;
}

/** Array of short strings: control-stripped, lowercased, deduped, count-capped. */
export function cleanVendorList(v: unknown, name: string, maxItems = 200): string[] {
  if (!Array.isArray(v)) throw new InputError(`${name} must be an array.`);
  if (v.length > maxItems) throw new InputError(`${name} allows at most ${maxItems} entries.`);
  const out: string[] = [];
  for (const item of v) {
    const s = cleanStr(item, `${name} entry`, 120);
    if (s) out.push(s.toLowerCase());
  }
  return [...new Set(out)];
}

/** 'HH:MM' 24-hour clock string. */
export function cleanHhmm(v: unknown, name: string): string {
  const s = cleanStr(v, name, 5);
  if (s === null || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    throw new InputError(`${name} must be a valid HH:MM time.`);
  }
  return s;
}
