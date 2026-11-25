import type { Site, SitePolicy } from './api';

// Web/PWA build: expo-secure-store has no browser backend, so the device
// session lives in localStorage (scoped to this origin).
const KEY = 'insync.site_session.v1';

export interface StoredSession {
  token: string;
  site: Site;
  policy: SitePolicy;
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.site?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  window.localStorage.setItem(KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}
