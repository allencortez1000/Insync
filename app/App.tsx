import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useNetInfo } from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';

import { BrandMark, colors } from './src/components/ui';
import { attemptsLeft, errorText, t, type Bi } from './src/i18n';
import {
  siteCheckRequest,
  siteLogout,
  sitePunch,
  siteRoster,
  siteSessionInfo,
  siteVerifyFace,
  siteVerifyPin,
  type Failure,
  type PunchAction,
  type PunchOk,
  type RosterEmployee,
  type RpcResult,
  type VerifyPinOk,
} from './src/lib/api';
import { faceSupported, preloadFaceApi } from './src/lib/face';
import { captureLocation, ensureLocationPermission, toPayload, type LocationReading } from './src/lib/location';
import { clearSession, loadSession, saveSession, type StoredSession } from './src/lib/storage';
import { supabaseConfigured } from './src/lib/supabase';
import { formatManilaDateTime, formatManilaTime, localDeadline } from './src/lib/time';
import { ConfirmScreen, type ConfirmPhase } from './src/screens/ConfirmScreen';
import { FaceScreen, type FaceResult } from './src/screens/FaceScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { MessageScreen } from './src/screens/MessageScreen';
import { PinScreen } from './src/screens/PinScreen';
import { RosterScreen } from './src/screens/RosterScreen';
import { SuccessScreen } from './src/screens/SuccessScreen';
import { UnsavedScreen } from './src/screens/UnsavedScreen';

/** A punch whose request id is fixed before the first submit and reused for every retry. */
interface PendingPunch {
  employee: RosterEmployee;
  auth: VerifyPinOk;
  authDeadline: number;
  action: PunchAction;
  requestId: string;
  reading: LocationReading;
}

type ScreenState =
  | { name: 'boot' }
  | { name: 'login'; notice?: Bi }
  | { name: 'roster'; notice?: Bi }
  | { name: 'pin'; employee: RosterEmployee; notice?: Bi }
  | { name: 'face'; employee: RosterEmployee; notice?: Bi }
  | {
      name: 'confirm';
      key: number;
      employee: RosterEmployee;
      auth: VerifyPinOk;
      authDeadline: number;
      phase: ConfirmPhase;
      notice?: Bi;
    }
  | { name: 'unsaved'; pending: PendingPunch; busy: boolean; notice?: Bi }
  | { name: 'success'; result: PunchOk }
  | { name: 'message'; title: Bi; lines?: Bi[]; detail?: string; tone: 'danger' | 'warn' };

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Main />
    </SafeAreaProvider>
  );
}

function openSessionDetail(failure: Failure): string | undefined {
  const open = failure.open_session;
  if (!open) return undefined;
  return `${open.site_name} · ${formatManilaDateTime(open.clock_in_at)}`;
}

function Main() {
  const [session, setSessionState] = useState<StoredSession | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const [screen, setScreenState] = useState<ScreenState>({ name: 'boot' });
  const screenRef = useRef<ScreenState>(screen);
  /** Incremented whenever the device returns to the roster/login; stale async results are dropped. */
  const flow = useRef(0);

  const [roster, setRoster] = useState<RosterEmployee[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<Bi | null>(null);

  const net = useNetInfo();
  const online = net.isConnected !== false && net.isInternetReachable !== false;

  const show = useCallback((next: ScreenState) => {
    screenRef.current = next;
    setScreenState(next);
  }, []);

  const setSession = useCallback((next: StoredSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const goRoster = useCallback(
    (notice?: Bi) => {
      flow.current += 1;
      show({ name: 'roster', notice });
    },
    [show],
  );
  const backToRoster = useCallback(() => goRoster(), [goRoster]);
  const timedOut = useCallback(() => goRoster(t.timedOut), [goRoster]);

  const goLogin = useCallback(
    (notice?: Bi) => {
      flow.current += 1;
      show({ name: 'login', notice });
    },
    [show],
  );

  const showMessage = useCallback(
    (title: Bi, opts: { lines?: Bi[]; detail?: string; tone?: 'danger' | 'warn' } = {}) => {
      show({ name: 'message', title, lines: opts.lines, detail: opts.detail, tone: opts.tone ?? 'danger' });
    },
    [show],
  );

  const sessionInvalid = useCallback(async () => {
    setSession(null);
    setRoster(null);
    await clearSession();
    goLogin(t.sessionExpired);
  }, [goLogin, setSession]);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabaseConfigured) {
        show({ name: 'login' });
        return;
      }
      const stored = await loadSession();
      if (cancelled) return;
      if (!stored) {
        show({ name: 'login' });
        return;
      }
      const info = await siteSessionInfo(stored.token);
      if (cancelled) return;
      if (info.kind === 'ok') {
        const refreshed: StoredSession = { token: stored.token, site: info.data.site, policy: info.data.policy };
        setSession(refreshed);
        void saveSession(refreshed).catch(() => undefined);
        goRoster();
        void ensureLocationPermission();
      } else if (info.kind === 'fail' && info.failure.code === 'SESSION_INVALID') {
        await clearSession();
        goLogin(t.sessionExpired);
      } else {
        // Offline at start: keep the stored session; punches still need the server.
        setSession(stored);
        goRoster();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goLogin, goRoster, setSession, show]);

  // ---------------------------------------------------------------- roster
  const loadRoster = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setRosterLoading(true);
    const result = await siteRoster(s.token);
    setRosterLoading(false);
    if (sessionRef.current?.token !== s.token) return;
    if (result.kind === 'ok') {
      setRoster(result.data.employees);
      setRosterError(null);
    } else if (result.kind === 'fail' && result.failure.code === 'SESSION_INVALID') {
      void sessionInvalid();
    } else {
      setRosterError(result.kind === 'network' ? t.networkError : t.rosterLoadFailed);
    }
  }, [sessionInvalid]);

  useEffect(() => {
    if (screen.name !== 'roster' || !session) return;
    void loadRoster();
    const id = setInterval(() => void loadRoster(), 60000);
    return () => clearInterval(id);
  }, [screen.name, session, loadRoster]);

  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && screenRef.current.name === 'roster') void loadRoster();
    wasOnline.current = online;
  }, [online, loadRoster]);

  // ---------------------------------------------------------------- Android back button
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const cur = screenRef.current;
      switch (cur.name) {
        case 'pin':
        case 'face':
        case 'message':
        case 'success':
          goRoster();
          return true;
        case 'confirm':
          if (cur.phase === 'idle') goRoster();
          return true;
        case 'unsaved':
        case 'roster':
          return true; // shared device: never exit by accident; unsaved needs an explicit choice
        default:
          return false;
      }
    });
    return () => sub.remove();
  }, [goRoster]);

  // ---------------------------------------------------------------- login / logout
  const onLoggedIn = useCallback(
    (s: StoredSession) => {
      setSession(s);
      setRoster(null);
      setRosterError(null);
      goRoster();
      void ensureLocationPermission(); // ask while staff is holding the device
    },
    [goRoster, setSession],
  );

  const signOut = useCallback(async () => {
    const s = sessionRef.current;
    if (s) void siteLogout(s.token); // best effort; staff can also revoke from the website
    setSession(null);
    setRoster(null);
    await clearSession();
    goLogin();
  }, [goLogin, setSession]);

  // ---------------------------------------------------------------- PIN
  // Load the face engine while people are still looking for their name, not after they tap it.
  useEffect(() => {
    if (faceSupported && roster?.some((e) => e.has_face)) preloadFaceApi();
  }, [roster]);

  // Employees who recorded their face are checked by the camera; everyone else types the PIN.
  const askWho = useCallback(
    (employee: RosterEmployee, notice?: Bi) =>
      show({ name: faceSupported && employee.has_face ? 'face' : 'pin', employee, notice }),
    [show],
  );
  const selectEmployee = useCallback((employee: RosterEmployee) => askWho(employee), [askWho]);

  const verifyFace = useCallback(
    async (employee: RosterEmployee, frames: number[][]): Promise<FaceResult> => {
      const s = sessionRef.current;
      if (!s) return { kind: 'done' };
      const f = flow.current;
      const result = await siteVerifyFace(s.token, employee.id, frames);
      if (flow.current !== f) return { kind: 'done' };

      if (result.kind === 'network') return { kind: 'error', lines: [t.networkError] };
      if (result.kind === 'error') return { kind: 'error', lines: [t.serverError] };
      if (result.kind === 'ok') {
        show({
          name: 'confirm',
          key: Date.now(),
          employee,
          auth: result.data,
          authDeadline: localDeadline(result.data.server_time, result.data.expires_at),
          phase: 'idle',
        });
        return { kind: 'done' };
      }

      const failure = result.failure;
      switch (failure.code) {
        case 'SESSION_INVALID':
          void sessionInvalid();
          return { kind: 'done' };
        case 'FACE_MISMATCH':
          return { kind: 'mismatch' };
        case 'FACE_NOT_ENROLLED':
          // The face was removed since the list was loaded: fall back to the PIN.
          show({ name: 'pin', employee, notice: errorText(failure.code) });
          return { kind: 'done' };
        case 'OPEN_AT_OTHER_SITE':
          showMessage(errorText(failure.code), { detail: openSessionDetail(failure), tone: 'warn' });
          return { kind: 'done' };
        case 'DEVICE_LOCKED':
        case 'NOT_ON_ROSTER':
          showMessage(errorText(failure.code));
          return { kind: 'done' };
        default:
          return { kind: 'error', lines: [errorText(failure.code)] };
      }
    },
    [sessionInvalid, show, showMessage],
  );

  const verifyPin = useCallback(
    async (employee: RosterEmployee, pin: string): Promise<Bi[] | null> => {
      const s = sessionRef.current;
      if (!s) return null;
      const f = flow.current;
      const result = await siteVerifyPin(s.token, employee.id, pin);
      if (flow.current !== f) return null;

      if (result.kind === 'network') return [t.networkError];
      if (result.kind === 'error') return [t.serverError];
      if (result.kind === 'ok') {
        show({
          name: 'confirm',
          key: Date.now(),
          employee,
          auth: result.data,
          authDeadline: localDeadline(result.data.server_time, result.data.expires_at),
          phase: 'idle',
        });
        return null;
      }

      const failure = result.failure;
      switch (failure.code) {
        case 'SESSION_INVALID':
          void sessionInvalid();
          return null;
        case 'PIN_INVALID':
          return failure.attempts_remaining != null
            ? [errorText(failure.code), attemptsLeft(failure.attempts_remaining)]
            : [errorText(failure.code)];
        case 'PIN_FORMAT':
          return [errorText(failure.code)];
        case 'PIN_LOCKED':
          showMessage(errorText(failure.code), {
            detail: failure.locked_until ? `Until ${formatManilaTime(failure.locked_until)}` : undefined,
          });
          return null;
        case 'OPEN_AT_OTHER_SITE':
          showMessage(errorText(failure.code), { detail: openSessionDetail(failure), tone: 'warn' });
          return null;
        case 'DEVICE_LOCKED':
        case 'PIN_NOT_SET':
        case 'NOT_ON_ROSTER':
          showMessage(errorText(failure.code));
          return null;
        default:
          return [errorText(failure.code)];
      }
    },
    [sessionInvalid, show, showMessage],
  );

  // ---------------------------------------------------------------- punch
  const handlePunchResult = useCallback(
    (result: RpcResult<PunchOk>, pending: PendingPunch, fromRetry: boolean) => {
      if (result.kind === 'ok') {
        show({ name: 'success', result: result.data });
        return;
      }
      if (result.kind === 'network') {
        // Outcome unknown: never claim success. Keep the same request id for the retry.
        show({ name: 'unsaved', pending, busy: false, notice: fromRetry ? t.stillOffline : undefined });
        return;
      }
      if (result.kind === 'error') {
        showMessage(t.serverError, { lines: [t.tryAgain] });
        return;
      }
      const failure = result.failure;
      switch (failure.code) {
        case 'SESSION_INVALID':
          void sessionInvalid();
          return;
        case 'PIN_EXPIRED':
          askWho(pending.employee, faceSupported && pending.employee.has_face ? t.faceTimedOut : errorText('PIN_EXPIRED'));
          return;
        case 'RETRY':
          if (Date.now() < pending.authDeadline - 3000) {
            show({
              name: 'confirm',
              key: Date.now(),
              employee: pending.employee,
              auth: pending.auth,
              authDeadline: pending.authDeadline,
              phase: 'idle',
              notice: errorText('RETRY'),
            });
          } else {
            askWho(pending.employee, errorText('RETRY'));
          }
          return;
        case 'ALREADY_CLOCKED_IN':
        case 'OPEN_AT_OTHER_SITE':
          showMessage(errorText(failure.code), { detail: openSessionDetail(failure), tone: 'warn' });
          return;
        case 'NOT_CLOCKED_IN':
          showMessage(errorText(failure.code), { tone: 'warn' });
          return;
        case 'LOCATION_REQUIRED':
          showMessage(errorText(failure.code), { lines: [t.locationRequiredNotice] });
          return;
        default:
          showMessage(errorText(failure.code));
      }
    },
    [sessionInvalid, show, showMessage],
  );

  const submitPunch = useCallback(
    async (pending: PendingPunch, f: number, fromRetry: boolean) => {
      const s = sessionRef.current;
      if (!s) return;
      const result = await sitePunch(
        s.token,
        pending.auth.auth_token,
        pending.action,
        pending.requestId,
        toPayload(pending.reading, s.policy.location_stale_ms),
      );
      if (flow.current !== f) return;
      handlePunchResult(result, pending, fromRetry);
    },
    [handlePunchResult],
  );

  const confirmPunch = useCallback(async () => {
    const cur = screenRef.current;
    const s = sessionRef.current;
    if (cur.name !== 'confirm' || cur.phase !== 'idle' || !s) return;
    const f = flow.current;
    const requestId = Crypto.randomUUID(); // fixed before the first submit
    show({ ...cur, phase: 'location', notice: undefined });
    const reading = await captureLocation(s.policy.location_stale_ms);
    if (flow.current !== f) return;
    const pending: PendingPunch = {
      employee: cur.employee,
      auth: cur.auth,
      authDeadline: cur.authDeadline,
      action: cur.auth.next_action,
      requestId,
      reading,
    };
    show({ ...cur, phase: 'saving', notice: undefined });
    await submitPunch(pending, f, false);
  }, [show, submitPunch]);

  const retryUnsaved = useCallback(async () => {
    const cur = screenRef.current;
    const s = sessionRef.current;
    if (cur.name !== 'unsaved' || cur.busy || !s) return;
    const f = flow.current;
    show({ ...cur, busy: true, notice: undefined });

    // First ask whether the original request was already saved.
    const check = await siteCheckRequest(s.token, cur.pending.requestId);
    if (flow.current !== f) return;
    if (check.kind === 'ok') {
      show({ name: 'success', result: check.data });
      return;
    }
    if (check.kind === 'network') {
      show({ ...cur, busy: false, notice: t.stillOffline });
      return;
    }
    if (check.kind === 'error') {
      show({ ...cur, busy: false, notice: t.serverError });
      return;
    }
    if (check.failure.code === 'SESSION_INVALID') {
      void sessionInvalid();
      return;
    }
    if (check.failure.code !== 'NOT_FOUND') {
      show({ ...cur, busy: false, notice: errorText(check.failure.code) });
      return;
    }
    // Not saved: resubmit with the SAME request id so the server can never double-record.
    await submitPunch(cur.pending, f, true);
  }, [sessionInvalid, show, submitPunch]);

  // ---------------------------------------------------------------- render
  switch (screen.name) {
    case 'boot':
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, backgroundColor: colors.bg }}>
          <BrandMark size={64} />
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );

    case 'login':
      return <LoginScreen notice={screen.notice} onLoggedIn={onLoggedIn} />;

    case 'roster':
      if (!session) return <LoginScreen onLoggedIn={onLoggedIn} />;
      return (
        <RosterScreen
          site={session.site}
          policy={session.policy}
          online={online}
          employees={roster}
          loading={rosterLoading}
          error={rosterError}
          notice={screen.notice}
          onRefresh={() => void loadRoster()}
          onSelect={selectEmployee}
          onSignOut={() => void signOut()}
        />
      );

    case 'pin': {
      const employee = screen.employee;
      return (
        <PinScreen
          key={employee.id}
          employee={employee}
          notice={screen.notice}
          onSubmit={(pin) => verifyPin(employee, pin)}
          onBack={backToRoster}
        />
      );
    }

    case 'face': {
      const employee = screen.employee;
      return (
        <FaceScreen
          key={employee.id}
          employee={employee}
          notice={screen.notice}
          onVerify={(frames) => verifyFace(employee, frames)}
          onUsePin={employee.has_pin === false ? undefined : () => show({ name: 'pin', employee })}
          onBack={backToRoster}
        />
      );
    }

    case 'confirm':
      return (
        <ConfirmScreen
          key={screen.key}
          auth={screen.auth}
          authDeadline={screen.authDeadline}
          phase={screen.phase}
          notice={screen.notice}
          onConfirm={() => void confirmPunch()}
          onCancel={backToRoster}
          onTimeout={timedOut}
        />
      );

    case 'unsaved':
      return (
        <UnsavedScreen
          employeeName={screen.pending.employee.name}
          action={screen.pending.action}
          busy={screen.busy}
          notice={screen.notice}
          onRetry={() => void retryUnsaved()}
          onLeave={backToRoster}
        />
      );

    case 'success':
      return <SuccessScreen result={screen.result} onDone={backToRoster} />;

    case 'message':
      return (
        <MessageScreen
          title={screen.title}
          lines={screen.lines}
          detail={screen.detail}
          tone={screen.tone}
          onPrimary={backToRoster}
        />
      );
  }
}
