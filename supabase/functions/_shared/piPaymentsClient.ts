// Pi's /v2/payments API for both Pi apps. Each app's server key sees only its own payments (Pi
// answers 404 payment_not_found for the other app's), so a payment is looked up with each
// configured key in turn, and every later call for it uses the key that found it.
//
// Keys come from env on each call: PI_API_KEY (the Testnet app), then PI_MAINNET_API_KEY (the
// Mainnet app). Never log a key, any part of it, or the Authorization header.
//
// /v2/me (the payer check) uses the user's Pi access token, not an app key, so it isn't here.

export type PiApp = 'testnet' | 'mainnet';

const PI_PAYMENTS_URL = 'https://api.minepi.com/v2/payments';

const KEY_ENV: { app: PiApp; env: string }[] = [
  { app: 'testnet', env: 'PI_API_KEY' },
  { app: 'mainnet', env: 'PI_MAINNET_API_KEY' },
];

/** The payment as Pi returns it (only the fields the functions read are typed) */
export interface PiPayment {
  identifier?: string;
  amount?: unknown;
  user_uid?: unknown;
  [field: string]: unknown;
}

/** Every Pi call for one payment, with the key of the app that has it */
export interface PiAppClient {
  app: PiApp;
  getPayment: (paymentId: string) => Promise<PiPaymentLookup>;
  approve: (paymentId: string) => Promise<Response>;
  complete: (paymentId: string, txid: string) => Promise<Response>;
  cancel: (paymentId: string) => Promise<Response>;
}

export type PiPaymentLookup =
  | { ok: true; payment: PiPayment; app: PiApp; client: PiAppClient }
  | {
      ok: false;
      /** payment_not_found: every key tried said so. pi_error: any other answer. network: no answer */
      reason: 'payment_not_found' | 'pi_error' | 'network';
      /** The app whose key gave this answer */
      app: PiApp;
      status: number | null;
      /** Pi's error text, first 300 characters (never the key) */
      piErrorBody: string;
      message?: string;
      keyLength: number;
      keyHasWhitespace: boolean;
    };

export interface PiPayments {
  /** The configured apps, in the order their keys are tried */
  apps: PiApp[];
  /** GET /v2/payments/{id} with each key in turn: the next key only after a 404 payment_not_found */
  getPayment: (paymentId: string) => Promise<PiPaymentLookup>;
  /**
   * The client for a payment without needing its details: with one key configured, that key
   * (no call to Pi, as before); with both, the key whose app has the payment
   */
  findClient: (
    paymentId: string,
  ) => Promise<
    { ok: true; client: PiAppClient } | Extract<PiPaymentLookup, { ok: false }>
  >;
}

const isPaymentNotFound = (status: number, body: string) =>
  status === 404 && body.includes('payment_not_found');

function appClient(app: PiApp, key: string): PiAppClient {
  const call = (path: string, method: 'GET' | 'POST', body?: unknown) =>
    fetch(`${PI_PAYMENTS_URL}/${path}`, {
      method,
      headers: {
        Authorization: `Key ${key}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const client: PiAppClient = {
    app,
    getPayment: async (paymentId) => {
      const keyInfo = {
        keyLength: key.length,
        keyHasWhitespace: /\s/.test(key),
      };
      let response: Response;
      try {
        response = await call(encodeURIComponent(paymentId), 'GET');
      } catch (error) {
        return {
          ok: false,
          reason: 'network',
          app,
          status: null,
          piErrorBody: '',
          message: error instanceof Error ? error.message : String(error),
          ...keyInfo,
        };
      }
      if (response.ok) {
        const payment = (await response.json()) as PiPayment;
        return { ok: true, payment, app, client };
      }
      const piErrorBody = (await response.text().catch(() => '')).slice(0, 300);
      return {
        ok: false,
        reason: isPaymentNotFound(response.status, piErrorBody)
          ? 'payment_not_found'
          : 'pi_error',
        app,
        status: response.status,
        piErrorBody,
        ...keyInfo,
      };
    },
    approve: (paymentId) =>
      call(`${encodeURIComponent(paymentId)}/approve`, 'POST'),
    complete: (paymentId, txid) =>
      call(`${encodeURIComponent(paymentId)}/complete`, 'POST', { txid }),
    cancel: (paymentId) =>
      call(`${encodeURIComponent(paymentId)}/cancel`, 'POST'),
  };
  return client;
}

/** The Pi payments API for the configured keys, or null when no key is set */
export function createPiPayments(): PiPayments | null {
  const clients = KEY_ENV.map(({ app, env }) => ({
    app,
    key: Deno.env.get(env) ?? '',
  }))
    .filter(({ key }) => key !== '')
    .map(({ app, key }) => appClient(app, key));
  if (clients.length === 0) return null;

  const getPayment = async (paymentId: string): Promise<PiPaymentLookup> => {
    let result: PiPaymentLookup | null = null;
    for (const client of clients) {
      result = await client.getPayment(paymentId);
      // Only "this app doesn't have it" moves on: a bad key, a 5xx or no answer stops here
      if (result.ok || result.reason !== 'payment_not_found') return result;
    }
    return result!;
  };

  return {
    apps: clients.map(({ app }) => app),
    getPayment,
    findClient: async (paymentId) => {
      if (clients.length === 1) return { ok: true, client: clients[0]! };
      const found = await getPayment(paymentId);
      return found.ok ? { ok: true, client: found.client } : found;
    },
  };
}

/**
 * Whether Pi's answer to approve / complete says it was done already. Pi's error bodies use
 * `error` (e.g. already_approved) and `error_message`, not `message`; all three are checked
 */
export const piSaysAlready = (
  body: unknown,
  done: 'approved' | 'completed',
): boolean => {
  if (!body || typeof body !== 'object') return false;
  const fields = body as Record<string, unknown>;
  if (fields['error'] === `already_${done}`) return true;
  const phrase = `already ${done}`;
  return [fields['error_message'], fields['message']].some(
    (text) => typeof text === 'string' && text.toLowerCase().includes(phrase),
  );
};
