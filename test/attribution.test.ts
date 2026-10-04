import { describe, expect, it } from 'vitest';
import { attributionFields, sanitizeSrc, srcFromRequestUrl } from '../src/attribution';
import { CLIENT_LABEL, VERSION } from '../src/version';
import pkg from '../package.json';

describe('sanitizeSrc', () => {
  it('defaults to mcp', () => {
    expect(sanitizeSrc(undefined)).toBe('mcp');
    expect(sanitizeSrc(null)).toBe('mcp');
    expect(sanitizeSrc('')).toBe('mcp');
    expect(sanitizeSrc('!!!')).toBe('mcp');
    expect(sanitizeSrc(42)).toBe('mcp');
  });
  it('lowercases and strips disallowed characters', () => {
    expect(sanitizeSrc('Registry')).toBe('registry');
    expect(sanitizeSrc('smithery.ai')).toBe('smithery.ai');
    expect(sanitizeSrc('a b<script>c')).toBe('abscriptc');
    expect(sanitizeSrc('x_y-z.1')).toBe('x_y-z.1');
    expect(sanitizeSrc('café​')).toBe('caf');
    expect(sanitizeSrc('"; DROP TABLE')).toBe('droptable');
  });
  it('caps length at 100', () => {
    expect(sanitizeSrc('a'.repeat(500))).toHaveLength(100);
  });
  it('reads ?src= from the request url', () => {
    expect(srcFromRequestUrl('https://mcp.rozo.ai/mcp?src=registry')).toBe('registry');
    expect(srcFromRequestUrl('https://mcp.rozo.ai/mcp')).toBe('mcp');
    expect(srcFromRequestUrl('https://mcp.rozo.ai/mcp?src=%3Cx%3E')).toBe('x');
    expect(srcFromRequestUrl('not a url')).toBe('mcp');
  });
});

describe('attributionFields', () => {
  it('matches the router whitelist shape', () => {
    const f = attributionFields('Docs');
    expect(f).toEqual({ client: CLIENT_LABEL, attribution: { client: CLIENT_LABEL, utm_source: 'docs' } });
    expect(Object.keys(f.attribution).sort()).toEqual(['client', 'utm_source']);
    expect(f.attribution.client.length).toBeLessThanOrEqual(64);
  });
  it('version constant matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
    expect(CLIENT_LABEL).toBe(`rozo-checkout-mcp/${pkg.version}`);
  });
});
