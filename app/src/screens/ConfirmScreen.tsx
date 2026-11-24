import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Banner, BigButton, BiText, Screen, colors, useIsWide } from '../components/ui';
import { actionLabel, t, type Bi } from '../i18n';
import type { VerifyPinOk } from '../lib/api';
import { formatManilaDateTime } from '../lib/time';

export type ConfirmPhase = 'idle' | 'location' | 'saving';

const INACTIVITY_MS = 30000;

export function ConfirmScreen({
  auth,
  authDeadline,
  phase,
  notice,
  onConfirm,
  onCancel,
  onTimeout,
}: {
  auth: VerifyPinOk;
  /** Local-clock ms when the single-use PIN authorization expires. */
  authDeadline: number;
  phase: ConfirmPhase;
  notice?: Bi;
  onConfirm: () => void;
  onCancel: () => void;
  onTimeout: () => void;
}) {
  const wide = useIsWide();
  // Fixed when the screen appears: the PIN authorization expiry or 30 s of inactivity, whichever is first.
  const [deadline] = useState(() => Math.min(authDeadline, Date.now() + INACTIVITY_MS));
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));
  const busy = phase !== 'idle';

  useEffect(() => {
    if (busy) return;
    const id = setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      setRemaining(left);
      if (left <= 0) {
        clearInterval(id);
        onTimeout();
      }
    }, 500);
    return () => clearInterval(id);
  }, [busy, deadline, onTimeout]);

  const action = auth.next_action;
  const color = action === 'clock_in' ? colors.clockIn : colors.clockOut;
  const busyLabel = phase === 'location' ? t.gettingLocation : t.saving;

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.container, wide && styles.wide]} bounces={false}>
        <Text style={styles.name} numberOfLines={2}>
          {auth.employee.name}
        </Text>
        <Text style={styles.code}>{auth.employee.code}</Text>

        {action === 'clock_out' && auth.open_session ? (
          <View style={styles.since}>
            <BiText text={t.clockedInSince} size={16} color={colors.muted} align="center" />
            <Text style={styles.sinceTime}>{formatManilaDateTime(auth.open_session.clock_in_at)}</Text>
          </View>
        ) : (
          <BiText text={t.notClockedIn} size={18} color={colors.muted} align="center" style={styles.since} />
        )}

        {notice && <Banner text={notice} tone="warn" />}

        <BigButton
          label={busy ? busyLabel : actionLabel(action)}
          onPress={onConfirm}
          color={color}
          size="xl"
          busy={busy}
          style={styles.action}
          accessibilityLabel={actionLabel(action).en}
        />
        {busy && <BiText text={busyLabel} size={18} align="center" color={colors.muted} />}

        <BigButton
          label={t.cancel}
          onPress={onCancel}
          variant="outline"
          color={colors.text}
          disabled={busy}
          size="lg"
        />

        {!busy && (
          <Text style={styles.countdown}>
            {t.timeLeft.en} {Math.ceil(remaining / 1000)}s · {t.timeLeft.fil} {Math.ceil(remaining / 1000)}s
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 16 },
  wide: { maxWidth: 620, width: '100%', alignSelf: 'center' },
  name: { fontSize: 34, fontWeight: '800', color: colors.text, textAlign: 'center' },
  code: { fontSize: 18, fontWeight: '600', color: colors.muted, textAlign: 'center' },
  since: { alignItems: 'center', marginVertical: 8 },
  sinceTime: { fontSize: 24, fontWeight: '700', color: colors.text, marginTop: 4, textAlign: 'center' },
  action: { marginTop: 8 },
  countdown: { textAlign: 'center', color: colors.muted, fontSize: 15 },
});
