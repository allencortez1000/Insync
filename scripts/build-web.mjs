// Builds ONE website: the admin site at "/" and the attendance PWA at "/site".
//   node scripts/build-web.mjs              -> output in ./dist
//   node scripts/build-web.mjs --site-only  -> only the attendance PWA, in app/dist
// Needs the Supabase URL + anon key as either VITE_SUPABASE_* or EXPO_PUBLIC_SUPABASE_* env vars.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Values from the environment win; otherwise read admin/.env, then the project-root .env.
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
}
const env = { ...readEnvFile(path.join(root, '.env')), ...readEnvFile(path.join(root, 'admin', '.env')), ...process.env };
env.VITE_SUPABASE_URL ??= env.EXPO_PUBLIC_SUPABASE_URL;
env.VITE_SUPABASE_ANON_KEY ??= env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
env.EXPO_PUBLIC_SUPABASE_URL ??= env.VITE_SUPABASE_URL;
env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= env.VITE_SUPABASE_ANON_KEY;
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
  console.error('Missing Supabase settings: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const run = (cmd, cwd) => execSync(cmd, { cwd: path.join(root, cwd), env, stdio: 'inherit' });
// --site-only: just export the attendance PWA to app/dist (used by `npm run dev`, where the
// admin dev server serves it at /site).
if (process.argv.includes('--site-only')) {
  run('npx expo export --platform web', 'app');
  console.log('Built app/dist  (attendance PWA, served at /site by the admin dev server)');
  process.exit(0);
}
run('npm run build', 'admin');
run('npx expo export --platform web', 'app');

const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'admin', 'dist'), out, { recursive: true });
fs.cpSync(path.join(root, 'app', 'dist'), path.join(out, 'site'), { recursive: true });
// PWA routes first, then the admin single-page app.
fs.writeFileSync(path.join(out, '_redirects'), '/site    /site/index.html   200\n/site/*  /site/index.html   200\n/*       /index.html        200\n');
console.log('\nBuilt dist/  (admin at /, attendance PWA at /site)');
