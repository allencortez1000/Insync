import type { ErrorCode, LocationStatus, PunchAction } from './lib/api';

/** A bilingual label: English first, Filipino second. */
export interface Bi {
  en: string;
  fil: string;
}

const bi = (en: string, fil: string): Bi => ({ en, fil });

export const t = {
  appName: bi('Insync Attendance', 'Insync Attendance'),

  // Login
  siteSignIn: bi('Site sign in', 'Pag-sign in ng site'),
  siteSignInHint: bi('For staff: enter the site name and the site password.', 'Para sa staff: ilagay ang pangalan ng site at ang password ng site.'),
  username: bi('Site name', 'Pangalan ng site'),
  password: bi('Password', 'Password'),
  signIn: bi('Sign in', 'Mag-sign in'),
  signingIn: bi('Signing in…', 'Nagsa-sign in…'),
  notConfigured: bi(
    'App is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.',
    'Hindi pa naka-configure ang app.',
  ),
  sessionExpired: bi('Site session ended. Please sign in again.', 'Natapos ang session ng site. Mag-sign in muli.'),

  // Roster
  selectName: bi('Tap your name', 'Pindutin ang iyong pangalan'),
  search: bi('Search name or code', 'Hanapin ang pangalan o code'),
  noEmployees: bi('No employees assigned to this site.', 'Walang empleyadong naka-assign sa site na ito.'),
  noMatches: bi('No matching names.', 'Walang tugmang pangalan.'),
  online: bi('Online', 'Online'),
  offline: bi('Offline', 'Walang koneksyon'),
  offlineBanner: bi(
    'No connection. Attendance cannot be saved until the connection returns.',
    'Walang koneksyon. Hindi maitatala ang attendance hangga\'t walang koneksyon.',
  ),
  rosterLoadFailed: bi('Could not refresh the list.', 'Hindi ma-refresh ang listahan.'),
  locationNotice: bi(
    'Your location is recorded only when you Clock In or Clock Out.',
    'Itinatala lamang ang iyong lokasyon kapag nag-time in o nag-time out ka.',
  ),
  locationRequiredNotice: bi(
    'Location must be turned on to record attendance.',
    'Kailangang naka-on ang lokasyon para maitala ang attendance.',
  ),
  locationReviewNotice: bi(
    'If location is unavailable, attendance is still saved and staff will review it.',
    'Kung walang lokasyon, maitatala pa rin at susuriin ito ng staff.',
  ),

  // PIN
  enterPin: bi('Enter your PIN', 'Ilagay ang iyong PIN'),
  checkingPin: bi('Checking…', 'Sinusuri…'),
  clear: bi('Clear', 'Burahin'),
  back: bi('Back', 'Bumalik'),
  notYou: bi('Not you? Go back', 'Hindi ikaw? Bumalik'),

  // Confirm
  clockIn: bi('Clock In', 'Mag-time in'),
  clockOut: bi('Clock Out', 'Mag-time out'),
  cancel: bi('Cancel', 'Kanselahin'),
  clockedInSince: bi('Clocked in since', 'Naka-time in mula'),
  notClockedIn: bi('You are not clocked in.', 'Hindi ka pa naka-time in.'),
  gettingLocation: bi('Getting location…', 'Kinukuha ang lokasyon…'),
  saving: bi('Saving…', 'Itinatala…'),
  timeLeft: bi('Closes in', 'Magsasara sa'),
  timedOut: bi('Time ran out. Enter your PIN again.', 'Naubos ang oras. Ilagay muli ang PIN.'),

  // Unsaved / retry
  notSavedYet: bi('Not saved yet', 'Hindi pa naitala'),
  notSavedBody: bi(
    'We could not confirm your attendance. Check the connection, then tap Retry. Do not start over.',
    'Hindi makumpirma ang attendance. Suriin ang koneksyon at pindutin ang Subukang muli. Huwag magsimula ulit.',
  ),
  retry: bi('Retry', 'Subukang muli'),
  retrying: bi('Checking…', 'Sinusuri…'),
  stillOffline: bi('Still no answer from the server.', 'Wala pa ring sagot mula sa server.'),
  leaveUnsaved: bi('Back to list', 'Bumalik sa listahan'),
  leaveUnsavedWarning: bi(
    'Your attendance may not be saved. Please tell staff.',
    'Maaaring hindi naitala ang attendance mo. Sabihan ang staff.',
  ),

  // Success
  saved: bi('Saved', 'Naitala na'),
  savedAt: bi('Saved at', 'Naitala noong'),
  done: bi('Done', 'Tapos na'),
  locationNotCaptured: bi(
    'Location was not captured. Staff will review this record.',
    'Hindi nakuha ang lokasyon. Susuriin ito ng staff.',
  ),

  // Settings
  settings: bi('Device settings', 'Settings ng device'),
  signOut: bi('Sign out this device', 'I-sign out ang device'),
  signOutConfirm: bi(
    'Sign out this device? The site password is needed to sign in again.',
    'I-sign out ang device? Kailangan ang password ng site para mag-sign in muli.',
  ),
  close: bi('Close', 'Isara'),
  ok: bi('OK', 'OK'),
  tryAgain: bi('Try again', 'Subukan muli'),
  serverError: bi('The server could not process this request.', 'Hindi maproseso ng server ang request.'),
  networkError: bi('Cannot reach the server. Check the connection.', 'Hindi maabot ang server. Suriin ang koneksyon.'),
};

export function actionLabel(action: PunchAction): Bi {
  return action === 'clock_in' ? t.clockIn : t.clockOut;
}

export function savedActionLabel(action: PunchAction): Bi {
  return action === 'clock_in' ? bi('Clocked in', 'Naka-time in na') : bi('Clocked out', 'Naka-time out na');
}

export function attemptsLeft(n: number): Bi {
  return bi(
    `${n} ${n === 1 ? 'try' : 'tries'} left before the PIN locks.`,
    `${n} pagsubok na lang bago ma-lock ang PIN.`,
  );
}

export function locationStatusLabel(status: LocationStatus): Bi {
  switch (status) {
    case 'captured':
      return bi('Location recorded', 'Naitala ang lokasyon');
    case 'permission_denied':
      return bi('Location permission is off', 'Naka-off ang pahintulot sa lokasyon');
    case 'timeout':
      return bi('Location took too long', 'Natagalan ang pagkuha ng lokasyon');
    case 'stale':
      return bi('Location was out of date', 'Luma na ang lokasyon');
    default:
      return bi('Location unavailable', 'Walang lokasyon');
  }
}

/** Short bilingual messages for server error codes. */
export function errorText(code: ErrorCode | string): Bi {
  switch (code) {
    case 'INVALID_LOGIN':
      return bi('Wrong site name or password.', 'Mali ang pangalan ng site o password.');
    case 'ACCOUNT_LOCKED':
      return bi('Too many failed sign-ins. Try again later.', 'Masyadong maraming maling pag-sign in. Subukan mamaya.');
    case 'ACCOUNT_DISABLED':
      return bi('This site account is disabled.', 'Naka-disable ang account ng site na ito.');
    case 'SESSION_INVALID':
      return t.sessionExpired;
    case 'NOT_ON_ROSTER':
      return bi('You are not on this site\'s list. Please see staff.', 'Wala ka sa listahan ng site na ito. Lumapit sa staff.');
    case 'PIN_FORMAT':
      return bi('PIN must be 6 digits.', 'Dapat 6 na numero ang PIN.');
    case 'PIN_NOT_SET':
      return bi('You have no PIN yet. Please see staff.', 'Wala ka pang PIN. Lumapit sa staff.');
    case 'PIN_INVALID':
      return bi('Wrong PIN.', 'Mali ang PIN.');
    case 'PIN_LOCKED':
      return bi('PIN locked for a while. Try later or see staff.', 'Naka-lock ang PIN. Subukan mamaya o lumapit sa staff.');
    case 'DEVICE_LOCKED':
      return bi(
        'Too many wrong PINs on this device. Wait 15 minutes or see staff.',
        'Masyadong maraming maling PIN sa device na ito. Maghintay ng 15 minuto o lumapit sa staff.',
      );
    case 'PIN_EXPIRED':
      return bi('Please enter your PIN again.', 'Ilagay muli ang iyong PIN.');
    case 'OPEN_AT_OTHER_SITE':
      return bi('You are still clocked in at another site.', 'Naka-time in ka pa sa ibang site.');
    case 'ALREADY_CLOCKED_IN':
      return bi('You are already clocked in.', 'Naka-time in ka na.');
    case 'NOT_CLOCKED_IN':
      return bi('You are not clocked in yet.', 'Hindi ka pa naka-time in.');
    case 'LOCATION_REQUIRED':
      return bi(
        'Location is required. Turn on location and try again.',
        'Kailangan ang lokasyon. I-on ang lokasyon at subukan muli.',
      );
    case 'RETRY':
      return bi('Something changed at the same moment. Please try again.', 'May nagbago nang sabay. Subukan muli.');
    case 'NOT_FOUND':
      return bi('No saved attendance found.', 'Walang naitalang attendance.');
    default:
      return t.serverError;
  }
}
