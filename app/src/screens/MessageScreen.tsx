import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { BigButton, BiText, Screen, colors, useIsWide } from '../components/ui';
import { t, type Bi } from '../i18n';

const AUTO_RETURN_MS = 12000;

/** Clear, full-screen message for errors that end the current attendance attempt. */
export function MessageScreen({
  title,
  lines,
  detail,
  tone = 'danger',
  primaryLabel = t.ok,
  onPrimary,
}: {
  title: Bi;
  lines?: Bi[];
  detail?: string;
  tone?: 'danger' | 'warn';
  primaryLabel?: Bi;
  onPrimary: () => void;
}) {
  const wide = useIsWide();

  // Never leave a shared device stuck on an error.
  useEffect(() => {
    const id = setTimeout(onPrimary, AUTO_RETURN_MS);
    return () => clearTimeout(id);
  }, [onPrimary]);

  const fg = tone === 'danger' ? colors.danger : colors.warnText;
  const bg = tone === 'danger' ? colors.dangerBg : colors.warnBg;

  return (
    <Screen style={{ backgroundColor: bg }}>
      <ScrollView contentContainerStyle={[styles.container, wide && styles.wide]} bounces={false}>
        <View style={[styles.icon, { backgroundColor: fg }]}>
          <Text style={styles.iconText}>!</Text>
        </View>
        <BiText text={title} size={30} weight="800" align="center" color={fg} />
        {lines?.map((line, i) => (
          <BiText key={i} text={line} size={19} align="center" color={colors.text} weight="500" />
        ))}
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        <BigButton label={primaryLabel} onPress={onPrimary} size="lg" color={fg} style={{ marginTop: 8 }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 16 },
  wide: { maxWidth: 620, width: '100%', alignSelf: 'center' },
  icon: { alignSelf: 'center', width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: '#FFFFFF', fontSize: 56, fontWeight: '900' },
  detail: { fontSize: 18, color: colors.text, textAlign: 'center', fontWeight: '600' },
});
