import * as SecureStore from 'expo-secure-store';
import type { Site, SitePolicy } from './api';

const KEY = 'insync.site_session.v1';

export interface StoredSession {
  token: string;
  site: Site;
  policy: SitePolicy;
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.site?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // nothing stored
  }
}
