import { ScrollView, StyleSheet, Text } from 'react-native';
import { confirmAction } from '../lib/confirm';
import { Banner, BigButton, BiText, Screen, StateIcon, colors, useIsWide } from '../components/ui';
import { actionLabel, t, type Bi } from '../i18n';
import type { PunchAction } from '../lib/api';

/**
 * Shown when the server did not reliably answer a Clock In/Out. The outcome is
 * unknown, so success is never claimed. Retry checks the original request first.
 */
export function UnsavedScreen({
  employeeName,
  action,
  busy,
  notice,
  onRetry,
  onLeave,
}: {
  employeeName: string;
  action: PunchAction;
  busy: boolean;
  notice?: Bi;
  onRetry: () => void;
  onLeave: () => void;
}) {
  const wide = useIsWide();

  function confirmLeave() {
    confirmAction(t.notSavedYet.en, t.leaveUnsavedWarning.en, t.retry.en, t.leaveUnsaved.en, onLeave, onRetry);
  }

  return (
    <Screen style={{ backgroundColor: colors.warnBg }}>
      <ScrollView contentContainerStyle={[styles.container, wide && styles.wide]} bounces={false}>
        <StateIcon name="cloud-offline-outline" color="#FFFFFF" background={colors.warnText} />
        <BiText text={t.notSavedYet} size={34} weight="800" align="center" color={colors.warnText} />
        <Text style={styles.who}>
          {employeeName} — {actionLabel(action).en}
        </Text>
        <BiText text={t.notSavedBody} size={18} align="center" color={colors.warnText} weight="500" />
        {notice && <Banner text={notice} tone="danger" />}
        <BigButton label={busy ? t.retrying : t.retry} onPress={onRetry} busy={busy} size="xl" color={colors.primary} icon="refresh" />
        <BigButton
          label={t.leaveUnsaved}
          onPress={confirmLeave}
          variant="outline"
          color={colors.text}
          disabled={busy}
          size="md"
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 16 },
  wide: { maxWidth: 620, width: '100%', alignSelf: 'center' },
  who: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' },
});
