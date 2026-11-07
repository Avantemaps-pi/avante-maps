/**
 * In-memory stand-in for the Supabase APIs an edge function calls through
 * supabase-js (auth "get user" and the PostgREST table endpoints), installed as
 * globalThis.fetch. Other hosts (Brevo, Pi Horizon) go to `external`.
 *
 * Supports what the functions use: select with eq/in/lt/gt filters, single
 * and maybeSingle, update (PATCH) with filters and returned rows, upsert
 * (POST with on_conflict), insert that fails on a duplicate key (primaryKeys)
 * and delete. RPC calls go to `rpc`.
 */

export type Row = Record<string, unknown>;

export interface FakeSupabase {
  tables: Record<string, Row[]>;
  /** Every request the function made, as "METHOD host/path" */
  calls: string[];
  restore: () => void;
}

export const FAKE_SUPABASE_URL = 'http://supabase.test';

// supabase-js captures fetch when a client is created, and some functions create theirs at
// import time, so fetch is replaced once (when this helper loads) by a dispatcher that sends
// each request to the fake installed at that moment
const realFetch = globalThis.fetch;
let activeFetch: typeof fetch | null = null;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => (activeFetch ?? realFetch)(input, init);

/** Sets the env the functions read at import time */
export function setFunctionEnv() {
  Deno.env.set('SUPABASE_URL', FAKE_SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'test-anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service');
  Deno.env.set('BREVO_API_KEY', 'test-brevo');
}

/** Imports an edge function's index.ts with Deno.serve stubbed, returning its handler */
export async function loadHandler(moduleUrl: string): Promise<(req: Request) => Promise<Response>> {
  const deno = Deno as unknown as { serve: unknown };
  const realServe = deno.serve;
  let handler: ((req: Request) => Promise<Response>) | undefined;
  deno.serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  try {
    await import(moduleUrl);
  } finally {
    deno.serve = realServe;
  }
  if (!handler) throw new Error(`${moduleUrl} did not call Deno.serve`);
  return handler;
}

const matches = (row: Row, params: URLSearchParams) => {
  for (const [key, raw] of params) {
    if (['select', 'on_conflict', 'columns', 'order', 'limit'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    // A JSON field (column->>key) compares as text
    if (key.includes('->>')) {
      const [column, field] = key.split('->>');
      const json = row[column!] as Record<string, unknown> | null | undefined;
      const text = json?.[field!] == null ? '' : String(json[field!]);
      if (op === 'eq' && text !== value) return false;
      continue;
    }
    if (op === 'eq' && String(row[key]) !== value) return false;
    // ISO timestamps compare correctly as strings
    if (op === 'lt' && !(String(row[key]) < value)) return false;
    if (op === 'gt' && !(String(row[key]) > value)) return false;
    if (op === 'lte' && !(String(row[key]) <= value)) return false;
    if (op === 'gte' && !(String(row[key]) >= value)) return false;
    if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',');
      if (!list.includes(String(row[key]))) return false;
    }
  }
  return true;
};

export function installFakeSupabase(options: {
  tables: Record<string, Row[]>;
  /** Bearer token → user id */
  users: Record<string, string>;
  external?: (url: URL, init: RequestInit | undefined) => Promise<Response | undefined> | Response | undefined;
  rpc?: (name: string, args: Row) => Response;
  /** Tables whose inserts fail */
  failInserts?: string[];
  /** Table → primary key column(s): a plain insert (no on_conflict) of an existing key fails with 23505 */
  primaryKeys?: Record<string, string | string[]>;
  /** Runs after an update, with the updated rows: stands in for a database trigger */
  afterUpdate?: (table: string, rows: Row[]) => void;
}): FakeSupabase {
  const fake: FakeSupabase = { tables: options.tables, calls: [], restore: () => (activeFetch = null) };

  activeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    fake.calls.push(`${method} ${url.host}${url.pathname}`);

    if (url.origin !== FAKE_SUPABASE_URL) {
      const res = await options.external?.(url, { method, headers: req.headers, body: method === 'GET' ? undefined : await req.text() });
      if (res) return res;
      throw new Error(`Unexpected request to ${url}`);
    }

    if (url.pathname === '/auth/v1/user') {
      const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '');
      const id = options.users[token];
      return id
        ? Response.json({ id, aud: 'authenticated', role: 'authenticated' })
        : Response.json({ message: 'invalid JWT' }, { status: 401 });
    }

    if (url.pathname.startsWith('/rest/v1/rpc/') && options.rpc) {
      return options.rpc(url.pathname.replace('/rest/v1/rpc/', ''), JSON.parse((await req.text()) || '{}'));
    }

    const table = url.pathname.replace('/rest/v1/', '');
    const rows = (fake.tables[table] ??= []);
    const accept = req.headers.get('accept') ?? '';
    const prefer = req.headers.get('prefer') ?? '';
    const asObject = accept.includes('vnd.pgrst.object');
    const respond = (data: Row[], status = 200) => {
      if (asObject) {
        if (data.length !== 1) return Response.json({ code: 'PGRST116', message: 'not exactly one row' }, { status: 406 });
        return Response.json(data[0], { status });
      }
      return Response.json(data, { status });
    };

    if (method === 'GET' || method === 'HEAD') return respond(rows.filter((r) => matches(r, url.searchParams)));

    const body = JSON.parse((await req.text()) || 'null');

    if (method === 'DELETE') {
      const hit = rows.filter((r) => matches(r, url.searchParams));
      // In place, so a test holding the array sees the change
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return prefer.includes('return=representation') ? respond(hit) : new Response(null, { status: 204 });
    }

    if (method === 'PATCH') {
      const hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      if (hit.length > 0) options.afterUpdate?.(table, hit);
      return prefer.includes('return=representation') ? respond(hit) : new Response(null, { status: 204 });
    }

    if (method === 'POST' && options.failInserts?.includes(table)) {
      return Response.json({ code: '42501', message: 'insert refused' }, { status: 403 });
    }

    if (method === 'POST') {
      const conflict = url.searchParams.get('on_conflict');
      const pk = options.primaryKeys?.[table];
      const keyColumns = pk === undefined ? [] : Array.isArray(pk) ? pk : [pk];
      if (!conflict && keyColumns.length > 0) {
        const items = Array.isArray(body) ? body : [body];
        if (items.some((item) => rows.some((r) => keyColumns.every((column) => r[column] === item[column])))) {
          return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint' }, { status: 409 });
        }
      }
      for (const item of Array.isArray(body) ? body : [body]) {
        const existing = conflict ? rows.find((r) => r[conflict] === item[conflict]) : undefined;
        if (existing) Object.assign(existing, item);
        else rows.push({ ...item });
      }
      return new Response(null, { status: 201 });
    }

    throw new Error(`Unsupported ${method} ${url}`);
  };

  return fake;
}
