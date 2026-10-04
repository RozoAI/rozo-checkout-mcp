/**
 * Compromised / attacker addresses. Mirrors @rozoai/checkout blacklist.json
 * (sync 2026-08-08) plus later entries from the operator's security table.
 * A deposit address that matches is never returned to the caller.
 */
const ADDRESSES = [
  'GD2UZOA5RFWILHTPQL6CDTLIT6XPEGZQXJX4NWQC7ZU7DCEXK5NSQ2GH',
  '0x8FE7155119d2975780c9e19B07dD98393965Bc2a',
  '0xa9E3Da13EF5eADFC6EcB2BB6BDddE95016B567dB',
  '0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897',
  'AEEtekA2EBYVy3e5Xx8fD3GkjWSoCsLvLzdD6pZTgHiH',
  'TBcegJf63xa5r7hi5jmqSsTnSEAAFkUcGu',
  '0x44d6B5a11FFc5Ba1043734d88af5E5dea36a648A',
  '0x467AeD16d024405116cF4Ba12976Bf63B404517b',
  'a23F2uanwzTDtWJmPK1y1DiKbnR7vCNZTqdQEacRz8W',
  '0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6',
  '9Ms2FNXMY9ucKwzxcnGxvqMcfSkBhRdPZhrsj1Ui1KiN',
  '0x49CD5655Cc9bf7c7C93fBb2DF36AA3020d11eEe0',
  'EHhTSkqPpu4TENNpdyLewgxaMckSUke3c9hoNVu6zNMA',
  'He9F3sHpDLN1br4Ts7AHpqQbGZaDkqgu2QK6dw93RpAk',
  'GAN3YSPDH5VW7YFJJFUJH7LIYTJBWGH3GJMKOG6FP5RKHXGNMPX44UYY',
  'TE78sm1mFajxtPjKMWQkLQTaBKQVqJVum4',
  '0xa9BacE1614d6cFf8aa159A2A41eE8BaA9a91Cc7B',
  '0xfD0e6fA2ABA8436e95f3Fb3523AC14Ba299c0e79',
  'GAIK5OR2FY4MVXVL4AZDJLAJT3MIJ5I6PAYARB2CATRRVACWFI7C6NHW',
  'GBQHLQMEPMBQEVFQXFAQ7EW54IVIC7VBGLTBCUJSRV7RUL7YAZ2CJ2IA',
  'GBWPIAYMQTF6B4P3WXHEY4JVBXBNQFWLWTVW26VHSWGEGWWNWRYLGDD6',
  'GD5TX5OAMDJ4JMGJSANBGKVL2YIPRGHVIZWD2KQYLIJRJNAMIQVSGERI',
];

function norm(a: string): string {
  const t = a.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? t.toLowerCase() : t;
}

const INDEX = new Set(ADDRESSES.map(norm));

export function isBlacklisted(address: unknown): boolean {
  return typeof address === 'string' && address.trim() !== '' && INDEX.has(norm(address));
}
