import { expect, it } from 'vitest';
import { formatMinor } from '../src/core/money.js';
import { fmt, toMinor, minorToUnits } from '../../web/src/lib/api.js';
it('formats zero-, two- and three-decimal atomic units consistently', () => {
  for (const format of [fmt, formatMinor]) {
    expect(format(1234, 'GBP')).toBe('£12.34');
    expect(format(1234, 'JPY')).toMatch(/1,234$/);
    expect(format(1234, 'KWD')).toMatch(/1\.234$/);
    expect(format(1234, 'USDC')).toBe('1234 USDC atomic units');
  }
});
it('parses policy money without rounding fractional atomic units or accepting token aliases', () => {
  expect(toMinor('12.34', 'GBP')).toBe(1234);
  expect(toMinor('12.345', 'GBP')).toBeNull();
  expect(toMinor('12', 'JPY')).toBe(12);
  expect(toMinor('12.5', 'JPY')).toBeNull();
  expect(toMinor('1.234', 'KWD')).toBe(1234);
  expect(toMinor('1', 'USDC')).toBeNull();
  expect(toMinor('1e3', 'GBP')).toBeNull();
  expect(minorToUnits(1234, 'KWD')).toBe('1.234');
});
