import * as Location from 'expo-location';
import type { LocationStatus } from './api';

/** Shape sent to site_punch as p_location. */
export interface LocationPayload {
  status: LocationStatus;
  latitude?: number;
  longitude?: number;
  accuracy_m?: number;
  captured_at?: string;
  age_ms?: number;
}

/** A location reading taken at the moment of the attendance action. */
export interface LocationReading {
  status: LocationStatus;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  /** Device-clock time of the fix, in ms since epoch. */
  fixTimeMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

// Ask the OS for permission at most once per app run; afterwards only read the status.
let askedThisRun = false;

export async function ensureLocationPermission(): Promise<boolean> {
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) return true;
    if (askedThisRun || !current.canAskAgain) return false;
    askedThisRun = true;
    const requested = await Location.requestForegroundPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Capture a fresh position for one attendance action. Never falls back to the
 * last-known position, and never invents coordinates.
 */
export async function captureLocation(staleMs: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LocationReading> {
  const granted = await ensureLocationPermission();
  if (!granted) return { status: 'permission_denied' };

  try {
    const enabled = await Location.hasServicesEnabledAsync();
    if (!enabled) return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }

  try {
    const result = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      timeoutMs,
    );
    if (result === 'timeout') return { status: 'timeout' };
    const fixTimeMs = result.timestamp;
    const age = Date.now() - fixTimeMs;
    return {
      status: age > staleMs ? 'stale' : 'captured',
      latitude: result.coords.latitude,
      longitude: result.coords.longitude,
      accuracyM: result.coords.accuracy ?? undefined,
      fixTimeMs,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Build the payload at submit time so age_ms is current (a retry after a network
 * failure reports the true age, letting the server mark it stale).
 */
export function toPayload(reading: LocationReading, staleMs: number): LocationPayload {
  if (reading.latitude == null || reading.longitude == null || reading.fixTimeMs == null) {
    return { status: reading.status === 'captured' ? 'unavailable' : reading.status };
  }
  const age = Math.max(0, Date.now() - reading.fixTimeMs);
  return {
    status: reading.status === 'captured' && age > staleMs ? 'stale' : reading.status,
    latitude: reading.latitude,
    longitude: reading.longitude,
    accuracy_m: reading.accuracyM,
    captured_at: new Date(reading.fixTimeMs).toISOString(),
    age_ms: Math.round(age),
  };
}
