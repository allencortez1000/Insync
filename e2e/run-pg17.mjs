// Runs the acceptance suite on a real, throw-away Postgres 17 server configured like a
// Supabase project (API roles, auth schema, and Supabase's permissive default privileges,
// so the migrations' lock-down is tested under the same starting conditions as production).
//   cd e2e && npm install && node run-pg17.mjs
import EmbeddedPostgres from 'embedded-postgres';
import pgPkg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '.pgdata');
fs.rmSync(dataDir, { recursive: true, force: true });

const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 54329, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],   // Supabase databases are UTF-8
  onLog: () => {}, onError: (e) => { if (!/^\s*$/.test(String(e)) && /FATAL|PANIC/.test(String(e))) console.error(String(e)); },
});
await server.initialise();
await server.start();

// Match PGlite's result types closely enough for the shared test file.
pgPkg.types.setTypeParser(1082, (v) => new Date(`${v}T00:00:00Z`)); // date

const client = new pgPkg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'postgres', database: 'postgres' });
await client.connect();

const SUPABASE_LIKE = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  grant usage on schema auth, extensions, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  -- Supabase's defaults: everything created in public is granted to the API roles.
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
`;
await client.query(SUPABASE_LIKE);

let inTx = false;
const api = {
  exec: (sql) => client.query(sql),
  query: (sql, params) => client.query(sql, params),
  async transaction(fn) {
    if (inTx) throw new Error('nested transaction');
    inTx = true;
    await client.query('begin');
    try {
      const out = await fn({ query: (s, p) => client.query(s, p), exec: (s) => client.query(s) });
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      inTx = false;
    }
  },
};
globalThis.__INSYNC_DB__ = api;

let code = 0;
try {
  const v = await client.query('select version()');
  console.log(v.rows[0].version.split(',')[0]);
  await import(pathToFileURL(path.join(here, '..', 'supabase', 'tests', 'acceptance.test.mjs')).href);

  // Lock-down audit under Supabase-like defaults: what can the app's role (anon) reach?
  const fn = await client.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
  const tb = await client.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
        or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete')) order by 1`);
  const noRls = await client.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`);
  const internal = await client.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\\_%' escape '\\' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`);
  // Supabase's safeupdate guard rejects UPDATE / DELETE without WHERE on API connections.
  const src = await client.query(`
    select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))`);
  const unsafe = [];
  for (const f of src.rows) {
    const body = f.prosrc.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
    for (const stmt of body.split(';')) {
      const m = stmt.match(/(?:^|\s)(delete\s+from|update)\s+[\s\S]*$/i);
      if (!m) continue;
      const s = m[0].trim();
      if (/^update\b/i.test(s) && !/\bset\b/i.test(s)) continue;              // "for update", "on conflict do update" handled below
      if (/on\s+conflict[\s\S]*do\s+update/i.test(stmt)) continue;
      if (!/\bwhere\b/i.test(s)) unsafe.push(`${f.proname}: ${s.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  console.log('\nLock-down audit (Supabase-like default privileges):');
  console.log('  UPDATE/DELETE without WHERE (blocked on Supabase):', unsafe.join(' | ') || '(none)');
  if (unsafe.length) code = 1;
  console.log('  functions anon can execute :', fn.rows.map((r) => r.proname).join(', ') || '(none)');
  console.log('  tables/views anon can touch:', tb.rows.map((r) => r.relname).join(', ') || '(none)');
  console.log('  tables without RLS         :', noRls.rows.map((r) => r.relname).join(', ') || '(none)');
  console.log('  internal fns callable by authenticated:', internal.rows.map((r) => r.proname).join(', ') || '(none)');
  const bad = fn.rows.filter((r) => !r.proname.startsWith('site_') && !r.proname.startsWith('emp_')).length + tb.rows.length + noRls.rows.length + internal.rows.length;
  if (bad) { console.error('✗ lock-down audit FAILED'); code = 1; } else console.log('✓ lock-down audit passed');
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await client.end().catch(() => {});
  await server.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(code || process.exitCode || 0);
