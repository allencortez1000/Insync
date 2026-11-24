import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Keypad } from '../components/Keypad';
import { Banner, BigButton, BiText, Screen, colors, useIsWide } from '../components/ui';
import { t, type Bi } from '../i18n';
import type { RosterEmployee } from '../lib/api';

const PIN_LENGTH = 6;
const INACTIVITY_MS = 30000;

export function PinScreen({
  employee,
  notice,
  onSubmit,
  onBack,
}: {
  employee: RosterEmployee;
  notice?: Bi;
  /** Resolves with error lines to show (PIN is cleared), or nothing when the flow moved on. */
  onSubmit: (pin: string) => Promise<Bi[] | null>;
  onBack: () => void;
}) {
  const wide = useIsWide();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Bi[] | null>(null);
  const mounted = useRef(true);
  const lastActivity = useRef(0);
  // Refs are the source of truth so fast taps never double-submit.
  const pinRef = useRef('');
  const busyRef = useRef(false);

  function updatePin(value: string) {
    pinRef.current = value;
    setPin(value);
  }

  useEffect(() => {
    mounted.current = true;
    lastActivity.current = Date.now();
    return () => {
      mounted.current = false;
    };
  }, []);

  // Return to the roster after inactivity so the device is ready for the next person.
  useEffect(() => {
    const id = setInterval(() => {
      if (!busy && Date.now() - lastActivity.current > INACTIVITY_MS) onBack();
    }, 1000);
    return () => clearInterval(id);
  }, [busy, onBack]);

  async function submit(full: string) {
    busyRef.current = true;
    setBusy(true);
    let result: Bi[] | null;
    try {
      result = await onSubmit(full);
    } catch {
      result = [t.serverError];
    }
    busyRef.current = false;
    if (!mounted.current) return;
    updatePin('');
    setBusy(false);
    lastActivity.current = Date.now();
    if (result) setErrors(result);
  }

  function press(digit: string) {
    if (busyRef.current) return;
    lastActivity.current = Date.now();
    setErrors(null);
    const current = pinRef.current;
    if (current.length >= PIN_LENGTH) return;
    const next = current + digit;
    updatePin(next);
    if (next.length === PIN_LENGTH) void submit(next);
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.container, wide && styles.containerWide]} bounces={false}>
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={2}>
            {employee.name}
          </Text>
          <Text style={styles.code}>{employee.code}</Text>
        </View>

        <BiText text={busy ? t.checkingPin : t.enterPin} size={24} weight="800" align="center" />

        <View style={styles.dots} accessibilityLabel={`${pin.length} of ${PIN_LENGTH} digits entered`}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <View key={i} style={[styles.dot, i < pin.length && styles.dotFilled]} />
          ))}
        </View>

        <View style={styles.messages}>
          {notice && !errors && <Banner text={notice} tone="info" />}
          {errors?.map((e, i) => <Banner key={i} text={e} tone={i === 0 ? 'danger' : 'warn'} />)}
        </View>

        <Keypad
          onDigit={press}
          onClear={() => {
            lastActivity.current = Date.now();
            updatePin('');
          }}
          onBackspace={() => {
            lastActivity.current = Date.now();
            updatePin(pinRef.current.slice(0, -1));
          }}
          disabled={busy}
        />

        <BigButton
          label={t.notYou}
          onPress={onBack}
          variant="outline"
          color={colors.text}
          size="md"
          disabled={busy}
          style={styles.back}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 16, gap: 14, justifyContent: 'center' },
  containerWide: { maxWidth: 560, width: '100%', alignSelf: 'center' },
  who: { alignItems: 'center' },
  name: { fontSize: 30, fontWeight: '800', color: colors.text, textAlign: 'center' },
  code: { fontSize: 18, fontWeight: '600', color: colors.muted, marginTop: 4 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 14, marginVertical: 6 },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: 3, borderColor: colors.text },
  dotFilled: { backgroundColor: colors.text },
  messages: { gap: 8, minHeight: 8 },
  back: { width: '100%', maxWidth: 440, alignSelf: 'center' },
});
