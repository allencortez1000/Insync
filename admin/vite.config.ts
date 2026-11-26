import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

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

/**
 * Face recognition engine (face-api.js + its three model files) served from this site at /face,
 * so nothing is fetched from another company's server when an employee uses the camera.
 * The files come straight from node_modules: served in dev, copied into dist/face on build.
 */
function faceAssets(): Plugin {
  const pkg = path.resolve(import.meta.dirname, 'node_modules/@vladmandic/face-api');
  const models = ['tiny_face_detector_model', 'face_landmark_68_model', 'face_recognition_model']
    .flatMap((m) => [`${m}.bin`, `${m}-weights_manifest.json`]);
  const fileFor = (url: string): string | null => {
    if (url === '/face/face-api.js') return path.join(pkg, 'dist/face-api.js');
    const m = url.match(/^\/face\/models\/([\w.-]+)$/);
    return m && models.includes(m[1]!) ? path.join(pkg, 'model', m[1]!) : null;
  };
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const file = fileFor((req.url ?? '').split('?')[0]!);
    if (!file) return next();
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end('face engine files are missing: run npm install in admin/'); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.setHeader('cache-control', 'public, max-age=86400');
    fs.createReadStream(file).pipe(res);
  };
  let outDir = '';
  return {
    name: 'insync-face-assets',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
    closeBundle() {
      if (!outDir || !fs.existsSync(outDir)) return;
      fs.mkdirSync(path.join(outDir, 'face/models'), { recursive: true });
      fs.copyFileSync(path.join(pkg, 'dist/face-api.js'), path.join(outDir, 'face/face-api.js'));
      for (const f of models) fs.copyFileSync(path.join(pkg, 'model', f), path.join(outDir, 'face/models', f));
    },
  };
}

export default defineConfig(({ mode }) => {
  // One .env for the whole project: when admin/.env does not set the Supabase values,
  // reuse the attendance app's EXPO_PUBLIC_* values from the project root .env.
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, '..'), ['VITE_', 'EXPO_PUBLIC_']);
  // Only set a value when there is one: assigning undefined to process.env stores the text "undefined",
  // which then overrides admin/.env and breaks the Supabase client ("Invalid supabaseUrl").
  const fallback = (name: string, value: string | undefined) => {
    const real = (v: string | undefined) => (v && v !== 'undefined' ? v : undefined);
    if (real(process.env[name])) return;
    if (real(value)) process.env[name] = value;
    else delete process.env[name];
  };
  fallback('VITE_SUPABASE_URL', rootEnv.VITE_SUPABASE_URL ?? rootEnv.EXPO_PUBLIC_SUPABASE_URL);
  fallback('VITE_SUPABASE_ANON_KEY', rootEnv.VITE_SUPABASE_ANON_KEY ?? rootEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY);
  return {
    // `npm run dev:phone` (mode "phone"): HTTPS with a self-signed certificate and reachable from the
    // local network, because phone browsers only allow the camera on https pages.
    plugins: [sitePwa(), faceAssets(), react(), tailwindcss(), ...(mode === 'phone' ? [basicSsl()] : [])],
    server: { port: 5173, host: mode === 'phone' ? true : undefined },
  };
});
