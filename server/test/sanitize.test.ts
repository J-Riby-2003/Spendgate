// Unit tests for the input guards shared by every surface (REST + MCP).
import { describe, expect, it } from 'vitest';
import { cleanHhmm, cleanMinor, cleanStr, cleanVendorList, InputError } from '../src/core/sanitize.js';

describe('cleanStr', () => {
  it('trims and returns the string', () => {
    expect(cleanStr('  acme  ', 'vendor', 120)).toBe('acme');
  });

  it('strips NUL and control characters', () => {
    expect(cleanStr('a\0b\nc\td', 'vendor', 120)).toBe('abcd');
  });

  it('throws when required and absent', () => {
    expect(() => cleanStr(undefined, 'vendor', 120)).toThrow(InputError);
    expect(() => cleanStr(null, 'vendor', 120)).toThrow(InputError);
    expect(() => cleanStr('   ', 'vendor', 120)).toThrow(InputError);
  });

  it('returns null when optional and absent/empty', () => {
    expect(cleanStr(undefined, 'note', 500, true)).toBeNull();
    expect(cleanStr('', 'note', 500, true)).toBeNull();
  });

  it('throws on non-strings', () => {
    expect(() => cleanStr(42, 'vendor', 120)).toThrow(InputError);
  });

  it('enforces the max length', () => {
    expect(() => cleanStr('x'.repeat(121), 'vendor', 120)).toThrow(/too long/);
    expect(cleanStr('x'.repeat(120), 'vendor', 120)).toHaveLength(120);
  });
});

describe('cleanMinor', () => {
  it('treats null/undefined/empty as unlimited', () => {
    expect(cleanMinor(null, 'maxPerTxn')).toBeNull();
    expect(cleanMinor(undefined, 'maxPerTxn')).toBeNull();
    expect(cleanMinor('', 'maxPerTxn')).toBeNull();
  });

  it('accepts whole minor-unit amounts', () => {
    expect(cleanMinor(0, 'maxPerTxn')).toBe(0);
    expect(cleanMinor(5000, 'maxPerTxn')).toBe(5000);
    expect(cleanMinor('5000', 'maxPerTxn')).toBe(5000);
  });

  it('rejects negative, fractional and non-finite values', () => {
    expect(() => cleanMinor(-1, 'maxPerTxn')).toThrow(InputError);
    expect(() => cleanMinor(10.5, 'maxPerTxn')).toThrow(InputError);
    expect(() => cleanMinor(Number.NaN, 'maxPerTxn')).toThrow(InputError);
    expect(() => cleanMinor('abc', 'maxPerTxn')).toThrow(InputError);
  });

  it('rejects amounts above 1e12 minor units', () => {
    expect(() => cleanMinor(1e12 + 1, 'maxPerTxn')).toThrow(/too large/);
    expect(cleanMinor(1e12, 'maxPerTxn')).toBe(1e12);
  });
});

describe('cleanVendorList', () => {
  it('lowercases, dedupes and strips control chars', () => {
    expect(cleanVendorList(['Acme', 'acme', 'a\0cme'], 'blockedVendors')).toEqual(['acme']);
  });

  it('rejects non-arrays and over-long lists', () => {
    expect(() => cleanVendorList('acme', 'blockedVendors')).toThrow(InputError);
    expect(() => cleanVendorList(Array(201).fill('v'), 'blockedVendors')).toThrow(/at most/);
  });
});

describe('cleanHhmm', () => {
  it('accepts valid 24h times', () => {
    expect(cleanHhmm('09:30', 'start')).toBe('09:30');
    expect(cleanHhmm('23:59', 'end')).toBe('23:59');
  });

  it('rejects malformed times', () => {
    for (const bad of ['24:00', '12:60', '9:30', '12.30', 'noon', '']) {
      expect(() => cleanHhmm(bad, 'start')).toThrow(InputError);
    }
  });
});
