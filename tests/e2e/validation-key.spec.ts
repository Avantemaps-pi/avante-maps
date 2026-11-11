/**
 * /validation-key.txt: Pi verifies each app's domain by fetching its key there, and every domain
 * is built from this repo, so the server picks the key by the request's host
 * (src/config/piValidationKeys.ts). The Mainnet key must stay byte-for-byte what
 * public/validation-key.txt held, or the Mainnet app loses its verification.
 */
import { test, expect } from './helpers/fixtures';
import {
  getPiValidationKey,
  normalizeHostname,
} from '../../src/config/piValidationKeys';

const MAINNET_KEY =
  '338d2a4e560fe3e5ee6180d36d8b26f4fc50acc3977f168bbf174afd8fece41eefc0e459e492c5f2b2153f99602b4ce154cb599403587809bf7d5a6aff70c044';
const TESTNET_KEY =
  '699271fd41de5671a8ebecfacc4d24e250d16cd428ec7ceed15470c59bfd9c118ad198be1dcb6eff37c4e8c5326e01e98f45f0d99a932d5831b75d9bc7e06397';

// Host the request came from, and the key it should get
const CASES: Array<[string, string]> = [
  ['testnet.avantemaps.com', TESTNET_KEY],
  ['avantemaps.com', MAINNET_KEY],
  ['mainnet.avantemaps.com', MAINNET_KEY],
  ['unknown.example.com', MAINNET_KEY],
];

// Vite's dev server answers 403 to a Host it doesn't know, so the Host cases run only against a
// built server (PREVIEW_URL); X-Forwarded-Host (what Vercel's proxy sends) runs everywhere.
const HEADER_KINDS = ['host', 'x-forwarded-host'] as const;

for (const kind of HEADER_KINDS) {
  for (const [host, key] of CASES) {
    test(`/validation-key.txt for ${kind} ${host}`, async ({ request }) => {
      test.skip(
        kind === 'host' && !process.env.PREVIEW_URL,
        "Vite's dev server refuses unknown Host headers",
      );
      const res = await request.get('/validation-key.txt', {
        headers: { [kind]: host },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toMatch(/^text\/plain/);
      expect(res.headers()['cache-control']).toBe(
        'no-store, max-age=0, s-maxage=0, must-revalidate',
      );
      // One trailing newline, as the static file had
      expect(await res.text()).toBe(`${key}\n`);
    });
  }
}

test('host to key: lower-cased, port stripped, first of a list', () => {
  expect(normalizeHostname('TESTNET.AvanteMaps.com:443')).toBe(
    'testnet.avantemaps.com',
  );
  expect(normalizeHostname('testnet.avantemaps.com, proxy.internal')).toBe(
    'testnet.avantemaps.com',
  );
  expect(getPiValidationKey('Testnet.avantemaps.com:8080')).toBe(TESTNET_KEY);
  expect(getPiValidationKey('avantemaps.com')).toBe(MAINNET_KEY);
  expect(getPiValidationKey('mainnet.avantemaps.com')).toBe(MAINNET_KEY);
  expect(getPiValidationKey('localhost:8080')).toBe(MAINNET_KEY);
  expect(getPiValidationKey('preview-abc.vercel.app')).toBe(MAINNET_KEY);
  expect(getPiValidationKey(null)).toBe(MAINNET_KEY);
  // The X-Forwarded-Host spoof only ever gets another public key
  expect(getPiValidationKey('testnet.avantemaps.com.evil.com')).toBe(
    MAINNET_KEY,
  );
});
