# Insync Attendance (Expo)

Shared site attendance app for phones and tablets. One site account signs in; employees pick their name, enter their 6-digit PIN, and record Clock In / Clock Out. It talks only to the `site_*` RPC functions in `supabase/migrations/*_attendance_device_api.sql` using the anon key. It never uses Supabase Auth.

## Setup

```bash
cd app
cp .env.example .env        # fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
npm install
npx expo start              # scan with Expo Go, or press a / i
```

Use the anon key only. Never put the `service_role` key in this app.

Builds: `npx eas-cli@latest build -p android` (or `-p ios`). Change `ios.bundleIdentifier` / `android.package` in `app.json` before you publish.

## Flow

Site login → roster (search by name or code) → PIN keypad → confirm (one button: Clock In **or** Clock Out, from the server) → location capture (fresh fix only, 8 s timeout) → save → success, then it returns to the roster after 4 s.

- **Idempotent saves:** the request id is created before the first submit. If the network fails, the app shows *Not saved yet* and never claims success. **Retry** first calls `site_check_request` and resubmits with the **same** request id only if nothing was saved.
- **Location:** it asks for foreground permission once (on sign-in), and never runs in the background. A denied, timed-out or stale fix is sent as that status, never as coordinates.
- **Timeouts:** the PIN screen and confirm screen go back to the roster after 30 s of inactivity. The confirm screen also closes when the single-use PIN authorization expires.
- **Staff-only settings:** press and hold the site name or the ⚙ icon for 1.5 s to open them, then sign the device out.

## Code

```
App.tsx                 screen state machine (boot, login, roster, pin, confirm, unsaved, success, message)
src/lib/supabase.ts     Supabase client (no session persistence)
src/lib/api.ts          typed RPC wrappers; network vs. server-failure classification
src/lib/location.ts     permission + fresh position capture
src/lib/storage.ts      device-session token in expo-secure-store
src/lib/time.ts         Asia/Manila formatting
src/i18n.ts             English / Filipino strings
src/components/         UI primitives, numeric keypad
src/screens/            one file per screen
```

Checks: `npx tsc --noEmit` and `npx eslint .`
