/**
 * Pi domain validation keys, served at /validation-key.txt (src/routes/validation-key[.]txt.ts).
 *
 * Each Pi app (Mainnet, Testnet) verifies its own domain with its own key, and every domain is
 * built from this repo, so the key is picked by the request's hostname. Exact-match only, like
 * MAINNET_PI_HOSTNAMES. Every other host (avantemaps.com, mainnet.avantemaps.com, previews,
 * localhost) gets the Mainnet app's key. Keys aren't secrets: Pi has them served publicly.
 */
export const DEFAULT_PI_VALIDATION_KEY =
  '338d2a4e560fe3e5ee6180d36d8b26f4fc50acc3977f168bbf174afd8fece41eefc0e459e492c5f2b2153f99602b4ce154cb599403587809bf7d5a6aff70c044';

export const PI_VALIDATION_KEYS: Record<string, string> = {
  'testnet.avantemaps.com':
    '699271fd41de5671a8ebecfacc4d24e250d16cd428ec7ceed15470c59bfd9c118ad198be1dcb6eff37c4e8c5326e01e98f45f0d99a932d5831b75d9bc7e06397',
};

/** Lower-cased, port stripped; the first value when a proxy sent a list. */
export const normalizeHostname = (host: string | null | undefined): string =>
  (host ?? '').split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '') ?? '';

export const getPiValidationKey = (host: string | null | undefined): string =>
  PI_VALIDATION_KEYS[normalizeHostname(host)] ?? DEFAULT_PI_VALIDATION_KEY;
