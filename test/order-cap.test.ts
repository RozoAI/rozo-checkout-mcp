import { describe, expect, it } from 'vitest';
// @ts-ignore: @types/node is not installed (Workers types only); vitest runs these tests in Node.
import { readFileSync, readdirSync } from 'node:fs';

// vitest runs from the repo root; paths are relative to it.
const join = (...parts: string[]) => parts.join('/');
const ROOT = '.';
import {
  NATIVE_MAX_CREDITS,
  NATIVE_MAX_USD,
  ORDER_CAP_USD,
  capInvoiceUsd,
  creditsForCap,
  effectiveNativeMaxUsd,
  liveNativeMaxUsd,
  nativeMaxUsdFor,
} from '../src/coins';

/* The order cap lives in ONE constant (src/coins.ts ORDER_CAP_USD, README "How to change the order cap"),
 * and the live per-coin cap from MPP Router quote-invoice wins when present. */
describe('order cap single source', () => {
  it('derives the credits promise from the cap (same formula as checkout caps.js)', () => {
    expect(NATIVE_MAX_USD).toBe(ORDER_CAP_USD);
    expect(NATIVE_MAX_CREDITS).toBe(creditsForCap(ORDER_CAP_USD));
    expect(creditsForCap(1200)).toBe(1100);
    expect(creditsForCap(12750)).toBe(11900);
    expect(creditsForCap(500)).toBe(460);
    expect(capInvoiceUsd(1200)).toBe(1155);
    // The promise fits strictly under the cap with the 1% fee and the 1% quote buffer.
    expect(capInvoiceUsd(ORDER_CAP_USD) * 1.01 * 1.01).toBeLessThan(ORDER_CAP_USD);
  });

  it('live cap first, fallback otherwise', () => {
    expect(liveNativeMaxUsd({ nativeMaxUsd: { '1': { ETH: 900 } } }, '1', 'eth')).toBe(900);
    expect(liveNativeMaxUsd({ nativeMaxUsd: { '1': { ETH: 'x' } } }, '1', 'ETH')).toBeNull();
    expect(liveNativeMaxUsd(null, '1', 'ETH')).toBeNull();
    expect(effectiveNativeMaxUsd({}, '137', 'POL')).toBe(nativeMaxUsdFor('POL'));
    expect(effectiveNativeMaxUsd({ nativeMaxUsd: { '137': { POL: 700 } } }, '137', 'POL')).toBe(700);
  });

  it('no source writes the credits or invoice figure as a literal', () => {
    const credits = creditsForCap(ORDER_CAP_USD).toLocaleString('en-US');
    const invoice = capInvoiceUsd(ORDER_CAP_USD).toLocaleString('en-US');
    const files = [...readdirSync(join(ROOT, 'src')).map((f: string) => join('src', f)), 'README.md'];
    for (const rel of files.filter((f) => /\.(ts|md)$/.test(f))) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      // README documents the current cap for humans; it must match the constant, not drift.
      if (rel === 'README.md') {
        for (const m of body.matchAll(/up to ([\d,]+)\s+credits \(about \$([\d,]+)\)/g)) {
          expect([m[1], m[2]], rel).toEqual([credits, invoice]);
        }
        continue;
      }
      expect(body.includes(`${credits} credits`) || body.includes(`$${invoice}`), rel).toBe(false);
    }
  });
});
