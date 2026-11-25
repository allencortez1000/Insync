import type { ErrorCode, LocationStatus, PunchAction } from './lib/api';

/** A UI label. The app is English only. */
export interface Bi {
  en: string;
}

const bi = (en: string): Bi => ({ en });

export const t = {
  appName: bi('Insync Attendance'),

  // Login
  siteSignIn: bi('Site sign in'),
  siteSignInHint: bi('For staff: enter the site name and the site password.'),
  username: bi('Site name'),
  password: bi('Password'),
  signIn: bi('Sign in'),
  signingIn: bi('Signing in…'),
  notConfigured: bi('App is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.'),
  sessionExpired: bi('Site session ended. Please sign in again.'),

  // Roster
  selectName: bi('Tap your name'),
  search: bi('Search name or code'),
  noEmployees: bi('No employees assigned to this site.'),
  noMatches: bi('No matching names.'),
  online: bi('Online'),
  offline: bi('Offline'),
  offlineBanner: bi('No connection. Attendance cannot be saved until the connection returns.'),
  rosterLoadFailed: bi('Could not refresh the list.'),
  locationNotice: bi('Your location is recorded only when you Clock In or Clock Out.'),
  locationRequiredNotice: bi('Location must be turned on to record attendance.'),
  locationReviewNotice: bi('If location is unavailable, attendance is still saved and staff will review it.'),

  // PIN
  enterPin: bi('Enter your PIN'),
  checkingPin: bi('Checking…'),
  clear: bi('Clear'),
  back: bi('Back'),
  notYou: bi('Not you? Go back'),

  // Confirm
  clockIn: bi('Clock In'),
  clockOut: bi('Clock Out'),
  cancel: bi('Cancel'),
  clockedInSince: bi('Clocked in since'),
  notClockedIn: bi('You are not clocked in.'),
  gettingLocation: bi('Getting location…'),
  saving: bi('Saving…'),
  timeLeft: bi('Closes in'),
  timedOut: bi('Time ran out. Enter your PIN again.'),

  // Unsaved / retry
  notSavedYet: bi('Not saved yet'),
  notSavedBody: bi('We could not confirm your attendance. Check the connection, then tap Retry. Do not start over.'),
  retry: bi('Retry'),
  retrying: bi('Checking…'),
  stillOffline: bi('Still no answer from the server.'),
  leaveUnsaved: bi('Back to list'),
  leaveUnsavedWarning: bi('Your attendance may not be saved. Please tell staff.'),

  // Success
  saved: bi('Saved'),
  savedAt: bi('Saved at'),
  done: bi('Done'),
  locationNotCaptured: bi('Location was not captured. Staff will review this record.'),

  // Settings
  settings: bi('Device settings'),
  signOut: bi('Sign out this device'),
  signOutConfirm: bi('Sign out this device? The site password is needed to sign in again.'),
  close: bi('Close'),
  ok: bi('OK'),
  tryAgain: bi('Try again'),
  serverError: bi('The server could not process this request.'),
  networkError: bi('Cannot reach the server. Check the connection.'),
};

export function actionLabel(action: PunchAction): Bi {
  return action === 'clock_in' ? t.clockIn : t.clockOut;
}

export function savedActionLabel(action: PunchAction): Bi {
  return action === 'clock_in' ? bi('Clocked in') : bi('Clocked out');
}

export function attemptsLeft(n: number): Bi {
  return bi(`${n} ${n === 1 ? 'try' : 'tries'} left before the PIN locks.`);
}

export function locationStatusLabel(status: LocationStatus): Bi {
  switch (status) {
    case 'captured':
      return bi('Location recorded');
    case 'permission_denied':
      return bi('Location permission is off');
    case 'timeout':
      return bi('Location took too long');
    case 'stale':
      return bi('Location was out of date');
    default:
      return bi('Location unavailable');
  }
}

/** Short messages for server error codes. */
export function errorText(code: ErrorCode | string): Bi {
  switch (code) {
    case 'INVALID_LOGIN':
      return bi('Wrong site name or password.');
    case 'ACCOUNT_LOCKED':
      return bi('Too many failed sign-ins. Try again later.');
    case 'ACCOUNT_DISABLED':
      return bi('This site account is disabled.');
    case 'SESSION_INVALID':
      return t.sessionExpired;
    case 'NOT_ON_ROSTER':
      return bi('You are not on this site\'s list. Please see staff.');
    case 'PIN_FORMAT':
      return bi('PIN must be 6 digits.');
    case 'PIN_NOT_SET':
      return bi('You have no PIN yet. Please see staff.');
    case 'PIN_INVALID':
      return bi('Wrong PIN.');
    case 'PIN_LOCKED':
      return bi('PIN locked for a while. Try later or see staff.');
    case 'DEVICE_LOCKED':
      return bi('Too many wrong PINs on this device. Wait 15 minutes or see staff.');
    case 'PIN_EXPIRED':
      return bi('Please enter your PIN again.');
    case 'OPEN_AT_OTHER_SITE':
      return bi('You are still clocked in at another site.');
    case 'ALREADY_CLOCKED_IN':
      return bi('You are already clocked in.');
    case 'NOT_CLOCKED_IN':
      return bi('You are not clocked in yet.');
    case 'LOCATION_REQUIRED':
      return bi('Location is required. Turn on location and try again.');
    case 'RETRY':
      return bi('Something changed at the same moment. Please try again.');
    case 'NOT_FOUND':
      return bi('No saved attendance found.');
    default:
      return t.serverError;
  }
}
