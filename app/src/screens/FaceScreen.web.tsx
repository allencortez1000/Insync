// Web / PWA build: the employee tapped their name and now looks at the camera instead of typing a PIN.
// The picture is turned into a face template on this device; only the template is sent, and the
// server decides whether it matches the face the employee recorded in their own account.
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Avatar, Banner, BigButton, BiText, Screen, colors, useIsWide } from '../components/ui';
import { t, type Bi } from '../i18n';
import type { RosterEmployee } from '../lib/api';
import { CameraError, closeCamera, faceHint, goodFace, loadFaceApi, openCamera, readFace } from '../lib/face.web';
import type { FaceResult } from './FaceScreen';

const MAX_MISMATCHES = 4;
const GIVE_UP_MS = 45000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function FaceScreen({
  employee,
  notice,
  onVerify,
  onUsePin,
  onBack,
}: {
  employee: RosterEmployee;
  notice?: Bi;
  /** Sends two camera frames (face templates) to the server; both must match the recorded face. */
  onVerify: (frames: number[][]) => Promise<FaceResult>;
  /** Offered only when the camera cannot be used on this device. */
  onUsePin?: () => void;
  onBack: () => void;
}) {
  const wide = useIsWide();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'starting' | 'looking' | 'checking' | 'failed' | 'nocamera'>('starting');
  const [hint, setHint] = useState<Bi>(t.faceStarting);
  const [errors, setErrors] = useState<Bi[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onBackRef = useRef(onBack);
  onVerifyRef.current = onVerify;
  onBackRef.current = onBack;

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    const started = Date.now();
    setPhase('starting');
    setHint(t.faceStarting);
    setErrors(null);
    setProblem(null);

    (async () => {
      if (!video) return;
      let api: unknown;
      try {
        const [engine, opened] = await Promise.all([loadFaceApi(), openCamera(video, () => stopped)]);
        api = engine;
        stream = opened;
      } catch (e) {
        closeCamera(stream, video);
        if (stopped) return;
        setProblem(e instanceof CameraError ? e.message : t.faceEngineFailed.en);
        setPhase('nocamera');
        return;
      }
      if (stopped) {
        closeCamera(stream, video);
        return;
      }
      setPhase('looking');
      let mismatches = 0;
      let lastSent = 0;
      let firstFrame: { descriptor: number[]; at: number } | null = null;
      while (!stopped) {
        // Hand the device back to the roster when nobody completes the check.
        if (Date.now() - started > GIVE_UP_MS) {
          onBackRef.current();
          return;
        }
        let reading = null;
        try {
          reading = await readFace(api, video);
        } catch {
          reading = null;
        }
        if (stopped) return;
        setHint({ en: faceHint(reading) });
        if (!goodFace(reading)) {
          if (firstFrame && Date.now() - firstFrame.at > 2500) firstFrame = null;   // the person moved away: start over
        } else if (Date.now() - lastSent > 900) {
          // Two separate good frames are needed, a moment apart.
          if (!firstFrame) {
            firstFrame = { descriptor: reading.descriptor, at: Date.now() };
            await sleep(250);
            continue;
          }
          if (Date.now() - firstFrame.at < 300) {
            await sleep(100);
            continue;
          }
          const frames = [firstFrame.descriptor, reading.descriptor];
          firstFrame = null;
          setPhase('checking');
          setHint(t.faceChecking);
          let result: FaceResult;
          try {
            result = await onVerifyRef.current(frames);
          } catch {
            result = { kind: 'error', lines: [t.serverError] };
          }
          if (stopped) return;
          lastSent = Date.now();
          if (result.kind === 'done') return;
          if (result.kind === 'mismatch') {
            mismatches += 1;
            if (mismatches >= MAX_MISMATCHES) {
              closeCamera(stream, video);
              setErrors(null);
              setPhase('failed');
              return;
            }
            setErrors([t.faceNotRecognized]);
          } else {
            setErrors(result.lines);
          }
          setPhase('looking');
        }
        await sleep(140);
      }
    })();

    return () => {
      stopped = true;
      closeCamera(stream, video);
    };
  }, [attempt]);

  const stopped = phase === 'failed' || phase === 'nocamera';
  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.container, wide && styles.containerWide]} bounces={false}>
        <View style={styles.who}>
          <Avatar name={employee.name} size={56} />
          <Text style={styles.name} numberOfLines={2}>
            {employee.name}
          </Text>
          <Text style={styles.code}>{employee.code}</Text>
        </View>

        <View style={[styles.frame, phase === 'checking' && styles.frameChecking, stopped && styles.frameStopped]}>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: stopped ? 'none' : 'block' }}
          />
        </View>

        {phase === 'failed' ? (
          <View style={styles.messages}>
            <BiText text={t.faceFailed} size={24} weight="800" align="center" />
            <Banner text={t.faceFailedHint} tone="danger" />
          </View>
        ) : phase === 'nocamera' ? (
          <View style={styles.messages}>
            <BiText text={t.faceNoCamera} size={24} weight="800" align="center" />
            <Banner text={{ en: problem ?? t.faceEngineFailed.en }} tone="danger" />
          </View>
        ) : (
          <View style={styles.messages}>
            <BiText text={phase === 'starting' ? t.faceStarting : phase === 'checking' ? t.faceChecking : t.lookAtCamera} size={24} weight="800" align="center" />
            {phase === 'looking' && <BiText text={hint} size={17} weight="600" align="center" />}
            {notice && !errors && <Banner text={notice} tone="info" />}
            {errors?.map((e, i) => <Banner key={i} text={e} tone={i === 0 ? 'danger' : 'warn'} />)}
          </View>
        )}

        <View style={styles.actions}>
          {stopped && <BigButton label={t.tryAgain} onPress={() => setAttempt((n) => n + 1)} size="md" icon="refresh" style={styles.button} />}
          {phase === 'nocamera' && onUsePin && (
            <BigButton label={t.usePinInstead} onPress={onUsePin} variant="outline" size="md" icon="keypad" style={styles.button} />
          )}
          <BigButton label={t.notYou} onPress={onBack} variant="outline" color={colors.text} size="md" icon="arrow-back" style={styles.button} />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 16, gap: 14, justifyContent: 'center', alignItems: 'center' },
  containerWide: { maxWidth: 560, width: '100%', alignSelf: 'center' },
  who: { alignItems: 'center', gap: 4 },
  name: { fontSize: 24, fontWeight: '800', color: colors.text, textAlign: 'center' },
  code: { fontSize: 15, fontWeight: '600', color: colors.muted },
  frame: {
    width: '100%', maxWidth: 300, aspectRatio: 1, borderRadius: 9999, overflow: 'hidden',
    borderWidth: 5, borderColor: colors.primary, backgroundColor: '#111827',
  },
  frameChecking: { borderColor: '#16A34A' },
  frameStopped: { borderColor: colors.borderStrong, backgroundColor: colors.surface, maxWidth: 120 },
  messages: { gap: 8, width: '100%', maxWidth: 440 },
  actions: { gap: 10, width: '100%', maxWidth: 440 },
  button: { width: '100%' },
});
