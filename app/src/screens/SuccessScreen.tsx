import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Banner, BiText, Icon, Screen, colors } from '../components/ui';
import { locationStatusLabel, savedActionLabel, t } from '../i18n';
import type { PunchOk } from '../lib/api';
import { formatManilaDate, formatManilaTime } from '../lib/time';

const AUTO_RETURN_MS = 4000;

export function SuccessScreen({ result, onDone }: { result: PunchOk; onDone: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDone, AUTO_RETURN_MS);
    return () => clearTimeout(id);
  }, [onDone]);

  const color = result.action === 'clock_in' ? colors.clockIn : colors.clockOut;
  const locationMissing = result.location_status !== 'captured';

  return (
    <Screen style={{ backgroundColor: color }}>
      <Pressable style={styles.container} onPress={onDone} accessibilityRole="button" accessibilityLabel="Done">
        <View style={styles.check}>
          <Icon name="checkmark" size={80} color={color} />
        </View>
        <BiText text={savedActionLabel(result.action)} size={38} weight="900" color="#FFFFFF" align="center" />
        <Text style={styles.name} numberOfLines={2}>
          {result.employee.name}
        </Text>
        <View style={styles.timeBox}>
          <BiText text={t.savedAt} size={16} color="#FFFFFF" align="center" />
          <Text style={styles.time}>{formatManilaTime(result.server_time)}</Text>
          <View style={styles.dateRow}>
            <View style={styles.dateItem}>
              <Icon name="calendar-outline" size={18} color="#FFFFFF" />
              <Text style={styles.date}>{formatManilaDate(result.server_time)}</Text>
            </View>
            <View style={styles.dateItem}>
              <Icon name="business-outline" size={18} color="#FFFFFF" />
              <Text style={styles.date}>{result.site.name}</Text>
            </View>
          </View>
        </View>
        {locationMissing && (
          <View style={styles.note}>
            <Banner text={locationStatusLabel(result.location_status)} tone="warn" />
            <Banner text={t.locationNotCaptured} tone="warn" />
          </View>
        )}
        <BiText text={t.done} size={16} color="#FFFFFF" align="center" style={{ opacity: 0.85 }} />
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, width: '100%', maxWidth: 720, alignSelf: 'center' },
  check: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 32, fontWeight: '800', color: '#FFFFFF', textAlign: 'center' },
  timeBox: { alignItems: 'center' },
  time: { fontSize: 56, fontWeight: '900', color: '#FFFFFF' },
  dateRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', columnGap: 16, rowGap: 4 },
  dateItem: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  date: { fontSize: 18, color: '#FFFFFF', fontWeight: '600', flexShrink: 1 },
  note: { width: '100%', maxWidth: 560, gap: 8 },
});
