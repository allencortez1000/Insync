import { useEffect, useState } from 'react';

/**
 * Turns a recorded position into a readable place name (e.g. "San Jose, Balanga, Bataan")
 * using OpenStreetMap Nominatim reverse geocoding. Only the coordinates are sent.
 *
 * Nominatim's usage policy allows light use only: at most one request per second, and results
 * must be cached. Both are done here (results are kept in this browser's localStorage).
 * The stored coordinates stay the evidence; the name is for reading convenience.
 */
const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const CACHE_KEY = 'insync.placeNames.v1';
const MIN_GAP_MS = 1100;

type Cache = Record<string, string>;
let cache: Cache | null = null;
const inFlight = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();
let lastRequest = 0;

function loadCache(): Cache {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Cache; } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try {
    const entries = Object.entries(loadCache());
    // keep the newest 2,000 names
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-2000))));
  } catch { /* storage full or blocked: names are just looked up again */ }
}

// ~11 m grid: nearby fixes share one lookup.
const keyOf = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

interface NominatimAddress { [k: string]: string | undefined }

function shortName(address: NominatimAddress | undefined, fallback: string | undefined): string | null {
  if (!address) return fallback ?? null;
  const pick = (...keys: string[]) => keys.map((k) => address[k]).find(Boolean);
  const parts = [
    pick('road', 'pedestrian', 'industrial', 'commercial'),
    pick('suburb', 'village', 'quarter', 'neighbourhood', 'hamlet', 'city_district'),
    pick('city', 'town', 'municipality'),
    pick('state', 'province', 'region'),
  ].filter((p, i, all): p is string => !!p && all.indexOf(p) === i);
  return parts.length ? parts.join(', ') : (fallback ?? null);
}

async function fetchName(lat: number, lng: number): Promise<string | null> {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place lookup failed (${res.status})`);
  const body = (await res.json()) as { address?: NominatimAddress; display_name?: string; error?: string };
  if (body.error) return null;
  return shortName(body.address, body.display_name);
}

export function placeName(lat: number, lng: number): Promise<string | null> {
  const key = keyOf(lat, lng);
  const hit = loadCache()[key];
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(key);
  if (pending) return pending;
  // One request at a time, spaced out, as the service requires.
  const p = (queue = queue.catch(() => undefined).then(() => fetchName(lat, lng))) as Promise<string | null>;
  const done = p.then((name) => {
    if (name) { loadCache()[key] = name; saveCache(); }
    return name;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return done;
}

export function usePlaceName(lat: number | string | null | undefined, lng: number | string | null | undefined) {
  const la = lat == null ? null : Number(lat);
  const ln = lng == null ? null : Number(lng);
  const valid = la != null && ln != null && Number.isFinite(la) && Number.isFinite(ln);
  const cached = valid ? loadCache()[keyOf(la, ln)] : undefined;
  const [state, setState] = useState<{ name: string | null; loading: boolean; failed: boolean }>(
    { name: cached ?? null, loading: valid && !cached, failed: false });

  useEffect(() => {
    if (!valid) { setState({ name: null, loading: false, failed: false }); return; }
    const hit = loadCache()[keyOf(la, ln)];
    if (hit) { setState({ name: hit, loading: false, failed: false }); return; }
    let alive = true;
    setState({ name: null, loading: true, failed: false });
    placeName(la, ln)
      .then((name) => alive && setState({ name, loading: false, failed: !name }))
      .catch(() => alive && setState({ name: null, loading: false, failed: true }));
    return () => { alive = false; };
  }, [valid, la, ln]);

  return state;
}
