import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Serves the built attendance PWA (app/dist, from `npm run build:all` or `npx expo export -p web`)
 * at /site, so the admin website and the PWA share one local link, exactly like production.
 * For live editing of the PWA itself, use its own dev server: `npm run dev:site` (port 8081, /site).
 */
function sitePwa(): Plugin {
  const dist = path.resolve(import.meta.dirname, '../app/dist');
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
    '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.map': 'application/json',
  };
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url !== '/site' && !url.startsWith('/site/')) return next();
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      res.statusCode = 503;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('The attendance PWA is not built yet. Run "npm run build:all" in the project root, then reload.');
      return;
    }
    const rel = decodeURIComponent(url.slice('/site'.length)).replace(/^\/+/, '');
    let file = path.join(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: 'insync-site-pwa',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig(({ mode }) => {
  // One .env for the whole project: when admin/.env does not set the Supabase values,
  // reuse the attendance app's EXPO_PUBLIC_* values from the project root .env.
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, '..'), ['VITE_', 'EXPO_PUBLIC_']);
  process.env.VITE_SUPABASE_URL ??= rootEnv.VITE_SUPABASE_URL ?? rootEnv.EXPO_PUBLIC_SUPABASE_URL;
  process.env.VITE_SUPABASE_ANON_KEY ??= rootEnv.VITE_SUPABASE_ANON_KEY ?? rootEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  return {
    plugins: [sitePwa(), react(), tailwindcss()],
    server: { port: 5173 },
  };
});
