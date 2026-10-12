import { describe, expect, it } from 'vitest';
import { isNativeSource, offeredSources, toBaseUnits, tokenDecimals } from '../src/coins';

describe('toBaseUnits', () => {
  it('scales plain decimals by the token decimals', () => {
    expect(toBaseUnits('0.0142', 18)).toBe('14200000000000000');
    expect(toBaseUnits('1', 9)).toBe('1000000000');
    expect(toBaseUnits('5.12', 6)).toBe('5120000');
    expect(toBaseUnits('0.000000001', 9)).toBe('1');
    expect(toBaseUnits('2.50000000000', 6)).toBe('2500000');
    expect(toBaseUnits('0', 6)).toBe('0');
  });
  it('refuses values a wallet could not send exactly', () => {
    expect(toBaseUnits('0.0000000001', 9)).toBeNull();
    expect(toBaseUnits('1e-3', 18)).toBeNull();
    expect(toBaseUnits('-1', 18)).toBeNull();
    expect(toBaseUnits('', 18)).toBeNull();
    expect(toBaseUnits('1.', 18)).toBeNull();
  });
});

describe('native sources', () => {
  it('knows each chain native coin and its decimals', () => {
    expect(isNativeSource('1', 'eth')).toBe(true);
    expect(isNativeSource('42161', 'ETH')).toBe(true);
    expect(isNativeSource('8453', 'ETH')).toBe(true);
    expect(isNativeSource('56', 'BNB')).toBe(true);
    expect(isNativeSource('137', 'POL')).toBe(true);
    expect(isNativeSource('900', 'SOL')).toBe(true);
    expect(isNativeSource('900', 'USDC')).toBe(false);
    expect(isNativeSource('lightning', 'BTC')).toBe(false);
    expect(tokenDecimals('900', 'SOL')).toBe(9);
    expect(tokenDecimals('137', 'POL')).toBe(18);
    expect(tokenDecimals('lightning', 'BTC')).toBeNull();
  });
  it('offers natives only when the quote lists them, ignoring garbage', () => {
    expect(offeredSources(null).find((r) => r.chainId === '1')!.tokens).toEqual(['USDC', 'USDT']);
    expect(offeredSources({ '1': 'ETH' }).find((r) => r.chainId === '1')!.tokens).toEqual(['USDC', 'USDT']);
    expect(offeredSources({ '1': ['eth'] }).find((r) => r.chainId === '1')!.tokens).toEqual(['USDC', 'USDT', 'ETH']);
  });
});
