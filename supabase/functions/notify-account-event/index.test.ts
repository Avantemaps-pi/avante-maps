/**
 * Unit tests for notify-account-event with Supabase, the cron secret check and Brevo mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 test --allow-env --allow-net --allow-read supabase/functions/notify-account-event/index.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  installFakeSupabase,
  loadHandler,
  setFunctionEnv,
  type Row,
} from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
Deno.env.delete('PI_APP_LINK_BASE');
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const SECRET = 'test-cron-secret';
const OLD_EMAIL = 'hello@harbour.example';

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

function setup(options: { brevoOk?: boolean; business?: Row | null } = {}) {
  const sent: { to: string; subject: string; html: string }[] = [];
  const business: Row = {
    id: 7,
    business_name: 'Harbour <Light> & Co',
    pi_wallet_address: 'GNEWWALLETADDRESS1234567890XYZ9QR7',
    ...options.business,
  };
  const fake = installFakeSupabase({
    tables: { businesses: options.business === null ? [] : [business] },
    users: {},
    rpc: (name, args) => {
      if (name !== 'verify_cron_secret')
        throw new Error(`unexpected rpc ${name}`);
      return Response.json(args.provided === SECRET);
    },
    external: async (url, init) => {
      if (url.host !== 'api.brevo.com') return undefined;
      const body = JSON.parse(String(init?.body));
      sent.push({
        to: body.to[0].email,
        subject: body.subject,
        html: body.htmlContent,
      });
      return options.brevoOk === false
        ? new Response(`bad recipient ${OLD_EMAIL}`, { status: 400 })
        : Response.json({ messageId: 'm1' });
    },
  });
  return { fake, sent };
}

const logged: string[] = [];
const capture = (...args: unknown[]) =>
  logged.push(
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
  );
console.log = capture;
console.error = capture;
console.warn = capture;

const call = async (
  body: Record<string, unknown>,
  secret: string | null = SECRET,
) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret !== null) headers['X-Cron-Secret'] = secret;
  const res = await handler(
    new Request('http://fn/notify-account-event', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
};

const walletChange = (extra: Record<string, unknown> = {}) => ({
  kind: 'payout_wallet_changed',
  business_id: 7,
  old_confirmed_email: OLD_EMAIL,
  ...extra,
});

const run = async (
  options: Parameters<typeof setup>[0],
  fn: (ctx: ReturnType<typeof setup>) => Promise<void>,
) => {
  const ctx = setup(options);
  try {
    await fn(ctx);
  } finally {
    ctx.fake.restore();
  }
};

test('a missing or wrong secret is refused with 401, and nothing is sent', () =>
  run({}, async ({ sent }) => {
    assertEquals((await call(walletChange(), null)).status, 401);
    assertEquals((await call(walletChange(), 'wrong')).status, 401);
    assertEquals(sent, []);
  }));

test('an unknown kind or a bad body is a 400', () =>
  run({}, async ({ sent }) => {
    assertEquals(
      (await call({ kind: 'something_else', business_id: 7 })).status,
      400,
    );
    assertEquals(
      (await call({ kind: 'payout_wallet_changed', business_id: 'seven' }))
        .status,
      400,
    );
    assertEquals(sent, []);
  }));

test('a changed payout wallet is emailed to the old confirmed email: what changed, when, and the link back', () =>
  run({}, async ({ sent }) => {
    logged.length = 0;
    const res = await call(walletChange());
    assertEquals(res.status, 200);
    assertEquals(res.body, { sent: true });
    assertEquals(sent.length, 1);
    const email = sent[0]!;
    assertEquals(email.to, OLD_EMAIL);
    assertEquals(
      email.subject,
      'Payout wallet changed for Harbour <Light> & Co',
    );
    // Escaped, with the shortened new address
    assertStringIncludes(
      email.html,
      'The payout wallet for <strong>Harbour &lt;Light&gt; &amp; Co</strong> was changed to <strong>GNEW…9QR7</strong> on ',
    );
    assert(!email.html.includes('Harbour <Light>'));
    assert(
      !email.html.includes('GNEWWALLETADDRESS1234567890XYZ9QR7'),
      'not the whole address',
    );
    // When: a UTC date and time
    assert(
      / on [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} UTC\./.test(
        email.html,
      ),
      email.html,
    );
    assertStringIncludes(
      email.html,
      "If this wasn't you, open Avante Maps and change it back.",
    );
    assertStringIncludes(
      email.html,
      'href="https://avantemapsaebbcf9516.pinet.com/update-registration/7?field=piWalletAddress"',
    );
    assertStringIncludes(email.html, 'background: #2563EB; color: #ffffff');
    assert(
      !/Pi Network|Pi Core/i.test(email.html),
      'no Pi affiliation wording',
    );
    // Logs: ids and the outcome, never the address
    const output = logged.join('\n');
    assertStringIncludes(output, '"sent":true');
    assertStringIncludes(output, '"business_id":7');
    assert(!output.toLowerCase().includes('harbour.example'), output);
  }));

test('a removed wallet says so', () =>
  run({ business: { pi_wallet_address: null } }, async ({ sent }) => {
    assertEquals((await call(walletChange())).body, { sent: true });
    assertStringIncludes(
      sent[0]!.html,
      'The payout wallet for <strong>Harbour &lt;Light&gt; &amp; Co</strong> was removed on ',
    );
  }));

test('no confirmed email before the change: nothing is sent', () =>
  run({}, async ({ sent }) => {
    for (const old of [null, '', '   ', 'not-an-email']) {
      const res = await call(walletChange({ old_confirmed_email: old }));
      assertEquals(
        res.body,
        { sent: false, reason: 'no_confirmed_email' },
        String(old),
      );
    }
    assertEquals(
      (await call({ kind: 'payout_wallet_changed', business_id: 7 })).body
        .reason,
      'no_confirmed_email',
    );
    assertEquals(sent, []);
  }));

test('an unknown business sends nothing', () =>
  run({ business: null }, async ({ sent }) => {
    assertEquals((await call(walletChange())).body, {
      sent: false,
      reason: 'business_not_found',
    });
    assertEquals(sent, []);
  }));

test("a Brevo failure is a 502, and Brevo's reply (which can echo the address) isn't logged", () =>
  run({ brevoOk: false }, async ({ sent }) => {
    logged.length = 0;
    const res = await call(walletChange());
    assertEquals(res.status, 502);
    assertEquals(res.body, { sent: false, reason: 'email_failed' });
    assertEquals(sent.length, 1);
    assert(!logged.join('\n').toLowerCase().includes('harbour.example'));
  }));
