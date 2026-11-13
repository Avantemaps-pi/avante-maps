/**
 * Unit tests for verify-pi-auth with Pi's /v2/me and Supabase Auth mocked: every sign-in sets a
 * fresh random password and signs in with it; nothing is derived from the Pi uid or a key.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 deno test --no-lock --allow-env --allow-net --allow-read supabase/functions/verify-pi-auth/index.test.ts
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@1';
import {
  installFakeSupabase,
  loadHandler,
  setFunctionEnv,
  type Row,
} from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
// A JWT-shaped service key: its first 32 characters are the public JWT header the old password used
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service');
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const PI_UID = 'pi-uid-123';
const USERNAME = 'alice';
const EMAIL = `${PI_UID}@pi.local`;
const HEX64 = /^[0-9a-f]{64}$/;

interface AuthUser {
  id: string;
  email: string;
  password: string;
  user_metadata: Row;
}

// Supabase Auth in memory: admin list/create/update and the password grant, with every call recorded
function setup(options: { users?: AuthUser[]; failSignIns?: number } = {}) {
  const users = options.users ?? [];
  const created: { email: string; password: string }[] = [];
  const updated: { id: string; password?: string }[] = [];
  const signIns: { email: string; password: string; ok: boolean }[] = [];
  let failuresLeft = options.failSignIns ?? 0;

  const fake = installFakeSupabase({
    tables: { users: [] },
    users: {},
    external: (url) => {
      if (url.host === 'api.minepi.com' && url.pathname === '/v2/me') {
        return Response.json({ uid: PI_UID, username: USERNAME, wallet_address: null });
      }
      return undefined;
    },
    auth: (url, method, body) => {
      const path = url.pathname.replace('/auth/v1', '');
      if (path === '/admin/users' && method === 'GET') {
        return Response.json({ users: users.map(({ password: _p, ...u }) => u), aud: 'authenticated' });
      }
      if (path === '/admin/users' && method === 'POST') {
        const user: AuthUser = {
          id: `00000000-0000-0000-0000-00000000000${users.length + 1}`,
          email: String(body?.['email']),
          password: String(body?.['password']),
          user_metadata: (body?.['user_metadata'] as Row) ?? {},
        };
        users.push(user);
        created.push({ email: user.email, password: user.password });
        return Response.json({ id: user.id, email: user.email, user_metadata: user.user_metadata });
      }
      if (path.startsWith('/admin/users/') && method === 'PUT') {
        const id = path.split('/').pop()!;
        const user = users.find((u) => u.id === id);
        if (!user) return Response.json({ msg: 'User not found' }, { status: 404 });
        if (typeof body?.['password'] === 'string') user.password = body['password'];
        updated.push({ id, ...(typeof body?.['password'] === 'string' ? { password: body['password'] } : {}) });
        return Response.json({ id: user.id, email: user.email, user_metadata: user.user_metadata });
      }
      if (path === '/token' && url.searchParams.get('grant_type') === 'password') {
        const email = String(body?.['email']);
        const password = String(body?.['password']);
        const user = users.find((u) => u.email === email);
        const ok = !!user && user.password === password && failuresLeft === 0;
        if (failuresLeft > 0) failuresLeft--;
        signIns.push({ email, password, ok });
        if (!ok) {
          return Response.json(
            { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: `access-${signIns.length}`,
          refresh_token: `refresh-${signIns.length}`,
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: { id: user!.id, email, aud: 'authenticated', role: 'authenticated' },
        });
      }
      throw new Error(`Unexpected auth call ${method} ${url}`);
    },
  });
  return { fake, users, created, updated, signIns };
}

// A different IP per call keeps the 10-per-minute rate limit out of the way
let ip = 0;
const call = async () => {
  ip++;
  const res = await handler(
    new Request('http://fn/verify-pi-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${ip}` },
      body: JSON.stringify({ accessToken: 'pi-token', uid: PI_UID, username: USERNAME }),
    }),
  );
  return { status: res.status, json: await res.json() };
};

const existing = (): AuthUser => ({
  id: '00000000-0000-0000-0000-0000000000e1',
  email: EMAIL,
  // What the old code set: derived from the uid and the public JWT header
  password: `pi_${PI_UID}_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX`,
  user_metadata: { pi_uid: PI_UID, username: USERNAME },
});

const notDerived = (password: string) => {
  assertMatch(password, HEX64);
  assert(!password.includes(PI_UID));
  assert(!password.includes('eyJ'));
  assert(!password.includes('test-service'));
  assert(!password.includes('default-salt'));
};

test('new user: created with a random 64-hex password, then signed in with a fresh one', async () => {
  const { fake, created, updated, signIns, users } = setup();
  const { status, json } = await call();
  assertEquals(status, 200);
  assertEquals(json.verified, true);
  assertEquals(json.user.uid, users[0]!.id);
  assertEquals(json.user.pi_uid, PI_UID);
  assert(json.supabase_token && json.refresh_token);

  assertEquals(created.length, 1);
  assertEquals(created[0]!.email, EMAIL);
  notDerived(created[0]!.password);
  // The sign-in sets its own password: the creation one is never used to sign in
  assertEquals(updated.length, 1);
  notDerived(updated[0]!.password!);
  assertNotEquals(updated[0]!.password, created[0]!.password);
  assertEquals(signIns, [{ email: EMAIL, password: updated[0]!.password!, ok: true }]);
  // Nothing in the response carries a password
  assert(!JSON.stringify(json).includes(updated[0]!.password!));
  fake.restore();
});

test('existing user: a new random password on every sign-in, different each time, old one gone', async () => {
  const old = existing();
  const oldPassword = old.password;
  const { fake, created, updated, signIns } = setup({ users: [old] });

  const first = await call();
  const second = await call();
  assertEquals([first.status, second.status], [200, 200]);
  assertEquals(first.json.user.uid, old.id);
  assertEquals(created.length, 0);

  const passwords = updated.map((u) => u.password!);
  assertEquals(updated.map((u) => u.id), [old.id, old.id]);
  passwords.forEach(notDerived);
  assertNotEquals(passwords[0], passwords[1]);
  // Never signs in with the old derived password, and it no longer works
  assert(signIns.every((s) => s.password !== oldPassword));
  assertNotEquals(old.password, oldPassword);
  assertEquals(signIns.map((s) => s.password), passwords);
  fake.restore();
});

test('racing sign-in: the first fails with invalid credentials, one retry with another password succeeds', async () => {
  const { fake, updated, signIns } = setup({ users: [existing()], failSignIns: 1 });
  const { status, json } = await call();
  assertEquals(status, 200);
  assertEquals(json.verified, true);
  assertEquals(updated.length, 2);
  assertNotEquals(updated[0]!.password, updated[1]!.password);
  assertEquals(signIns.map((s) => s.ok), [false, true]);
  assertEquals(signIns[1]!.password, updated[1]!.password);
  fake.restore();
});

test('two failed sign-ins: no third try, the same "Session creation failed" response as before', async () => {
  const { fake, updated, signIns } = setup({ users: [existing()], failSignIns: 2 });
  const { status, json } = await call();
  assertEquals(status, 500);
  assertEquals([json.verified, json.error], [false, 'Session creation failed']);
  assertEquals(updated.length, 2);
  assertEquals(signIns.length, 2);
  fake.restore();
});

test('source: no password derived from the uid or a key', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  for (const banned of ['generateUserPassword', 'default-salt', "SUPABASE_SERVICE_ROLE_KEY')?.substring"]) {
    assert(!source.includes(banned), `index.ts still contains ${banned}`);
  }
});
