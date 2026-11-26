// Local test stack shared by the browser tests: throw-away Postgres 17 with the real migrations and the
// demo data, a small stand-in for the Supabase REST/Auth API, and the admin dev server pointed at it.
import EmbeddedPostgres from 'embedded-postgres';
import pgPkg from 'pg';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN = '00000000-0000-0000-0000-0000000000a1';

export async function startStack({ PG_PORT, API_PORT, WEB_PORT, name }) {
const BASE = `http://localhost:${WEB_PORT}`;
// ---------------------------------------------------------------- database
const dataDir = path.join(os.tmpdir(), `insync-${name}-pgdata`);
fs.rmSync(dataDir, { recursive: true, force: true });
const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {},
});
await server.initialise();
await server.start();
pgPkg.types.setTypeParser(1082, (v) => v);                       // date as text, like PostgREST
pgPkg.types.setTypeParser(1700, (v) => Number(v));               // numeric as JSON number
pgPkg.types.setTypeParser(1184, (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString());
const db = new pgPkg.Client({ host: 'localhost', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
await db.connect();
await db.query(`
  create schema if not exists extensions; create schema if not exists auth;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  grant usage on schema auth, extensions, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
const migDir = path.join(here, '..', 'supabase', 'migrations');
for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
await db.query(`insert into auth.users (id, email) values ($1, 'owner@example.com')`, [ADMIN]);
await db.query(`select public.bootstrap_admin('owner@example.com')`);
await db.query(fs.readFileSync(path.join(here, '..', 'supabase', 'demo', 'reset_and_seed_demo.sql'), 'utf8'));
console.log('database ready (migrations + demo data)');

// ---------------------------------------------------------------- Supabase API stand-in
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.catch(() => undefined).then(fn));
async function asRole(uid, fn) {
  await db.query('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    await db.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    const out = await fn();
    await db.query('commit');
    return out;
  } catch (e) { await db.query('rollback'); throw e; }
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = `${b64({ alg: 'none' })}.${b64({ sub: ADMIN, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const user = { id: ADMIN, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
const ident = (s) => { if (!/^[a-z_][a-z_0-9]*$/.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };

const api = http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  const send = (status, body) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204);
  const url = new URL(req.url, 'http://x');
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  let uid = null;
  try { uid = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString()).sub ?? null; } catch { /* anon key */ }
  try {
    if (url.pathname === '/auth/v1/token') {
      return send(200, { access_token: fakeJwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    }
    if (url.pathname === '/auth/v1/user') return send(200, user);
    if (url.pathname.startsWith('/auth/v1/')) return send(200, {});
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
    if (rpc) {
      const fn = rpc[1], keys = Object.keys(body);
      const sql = `select * from public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
      const r = await serial(() => asRole(uid, () => db.query(sql, keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k])))));
      const scalar = r.fields.length === 1 && r.fields[0].name === fn;
      return send(200, scalar ? r.rows[0]?.[fn] ?? null : r.rows);
    }
    const tbl = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
    if (tbl && req.method === 'GET') {
      const select = url.searchParams.get('select') ?? '*';
      const one = (req.headers.accept ?? '').includes('vnd.pgrst.object');
      if (select.includes('(')) return send(200, one ? null : []);          // embeds are not emulated
      const where = [], vals = [];
      for (const [k, v] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
        if (!v.startsWith('eq.')) return send(200, one ? null : []);
        vals.push(v.slice(3)); where.push(`${ident(k)}::text = $${vals.length}`);
      }
      const cols = select === '*' ? '*' : select.split(',').map((c) => ident(c.trim())).join(', ');
      const r = await serial(() => asRole(uid, () => db.query(`select ${cols} from public.${ident(tbl[1])}${where.length ? ' where ' + where.join(' and ') : ''} limit 200`, vals)));
      if (one) return r.rows.length === 1 ? send(200, r.rows[0]) : send(406, { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' });
      return send(200, r.rows);
    }
    return send(404, { message: `not emulated: ${req.method} ${url.pathname}` });
  } catch (e) {
    return send(400, { message: e.message, code: e.code ?? null, details: e.detail ?? null, hint: e.hint ?? null });
  }
});
await new Promise((r) => api.listen(API_PORT, r));

// ---------------------------------------------------------------- admin dev server
const vite = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: path.join(here, '..', 'admin'), shell: true, stdio: 'ignore',
  env: { ...process.env, VITE_SUPABASE_URL: `http://localhost:${API_PORT}`, VITE_SUPABASE_ANON_KEY: 'anon-test-key' },
});
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}


  async function stop() {
    try { if (process.platform === 'win32') execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: 'ignore' }); else vite.kill(); } catch { /* already gone */ }
    api.close();
    await db.end().catch(() => {});
    await server.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { db, BASE, API: `http://localhost:${API_PORT}`, stop };
}
