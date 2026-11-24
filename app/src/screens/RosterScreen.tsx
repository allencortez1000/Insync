import { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Banner, BigButton, BiText, ConnectionPill, MIN_TOUCH, Screen, colors } from '../components/ui';
import { t, type Bi } from '../i18n';
import type { RosterEmployee, Site, SitePolicy } from '../lib/api';

function fold(value: string): string {
  let s = value.toLowerCase();
  try {
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // normalize unsupported: plain lowercase match
  }
  return s;
}

export function RosterScreen({
  site,
  policy,
  online,
  employees,
  loading,
  error,
  notice,
  onRefresh,
  onSelect,
  onSignOut,
}: {
  site: Site;
  policy: SitePolicy;
  online: boolean;
  employees: RosterEmployee[] | null;
  loading: boolean;
  error: Bi | null;
  notice?: Bi;
  onRefresh: () => void;
  onSelect: (employee: RosterEmployee) => void;
  onSignOut: () => void;
}) {
  const { width } = useWindowDimensions();
  const columns = width >= 1100 ? 3 : width >= 700 ? 2 : 1;
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const filtered = useMemo(() => {
    const list = employees ?? [];
    const q = fold(query.trim());
    if (!q) return list;
    return list.filter((e) => fold(e.name).includes(q) || fold(e.code).includes(q) || fold(`${e.last_name} ${e.first_name}`).includes(q));
  }, [employees, query]);

  function confirmSignOut() {
    Alert.alert(t.signOut.en, `${t.signOutConfirm.en}\n\n${t.signOutConfirm.fil}`, [
      { text: t.cancel.en, style: 'cancel' },
      {
        text: t.signOut.en,
        style: 'destructive',
        onPress: () => {
          setSettingsOpen(false);
          onSignOut();
        },
      },
    ]);
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable
          style={{ flex: 1 }}
          onLongPress={() => setSettingsOpen(true)}
          delayLongPress={1500}
          accessibilityLabel={`Site ${site.name}`}
          accessibilityHint="Long press for device settings"
        >
          <Text style={styles.siteName} numberOfLines={1}>
            {site.name}
          </Text>
          <Text style={styles.siteCode}>{site.code}</Text>
        </Pressable>
        <ConnectionPill online={online} />
        <Pressable
          onLongPress={() => setSettingsOpen(true)}
          delayLongPress={1500}
          style={styles.gear}
          accessibilityRole="button"
          accessibilityLabel="Device settings"
          accessibilityHint="Staff only: press and hold to open"
          hitSlop={8}
        >
          <Text style={{ fontSize: 22, color: colors.muted }}>⚙</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <BiText text={t.selectName} size={24} weight="800" />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={`${t.search.en} · ${t.search.fil}`}
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          autoCapitalize="words"
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel="Search name or employee code"
        />

        {!online && <Banner text={t.offlineBanner} tone="danger" />}
        {online && error && <Banner text={error} tone="warn" />}
        {notice && <Banner text={notice} tone="info" />}

        <FlatList
          key={`cols-${columns}`}
          data={filtered}
          numColumns={columns}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 16 }}
          columnWrapperStyle={columns > 1 ? { gap: 12 } : undefined}
          refreshControl={<RefreshControl refreshing={loading && employees !== null} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                setQuery('');
                onSelect(item);
              }}
              style={({ pressed }) => [styles.row, { flex: 1 / columns }, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, code ${item.code}`}
            >
              <Text style={styles.name} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.code}>{item.code}</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            employees === null ? (
              <Text style={styles.empty}>{loading ? 'Loading… · Naglo-load…' : ''}</Text>
            ) : (
              <BiText
                text={query ? t.noMatches : t.noEmployees}
                size={18}
                color={colors.muted}
                align="center"
                style={{ marginTop: 32 }}
              />
            )
          }
        />

        <View style={styles.notice}>
          <BiText text={t.locationNotice} size={14} color={colors.muted} weight="500" />
          <BiText
            text={policy.location_failure_policy === 'block' ? t.locationRequiredNotice : t.locationReviewNotice}
            size={14}
            color={colors.muted}
            weight="500"
            style={{ marginTop: 6 }}
          />
        </View>
      </View>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <BiText text={t.settings} size={22} weight="800" />
            <Text style={styles.modalMeta}>
              {site.name} ({site.code})
            </Text>
            <BigButton label={t.signOut} onPress={confirmSignOut} color={colors.danger} style={{ marginTop: 20 }} />
            <BigButton
              label={t.close}
              onPress={() => setSettingsOpen(false)}
              variant="outline"
              color={colors.text}
              size="md"
              style={{ marginTop: 12 }}
            />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  siteName: { fontSize: 22, fontWeight: '800', color: colors.text },
  siteCode: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  gear: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, padding: 16, gap: 12 },
  search: {
    minHeight: 60,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    fontSize: 20,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  row: {
    minHeight: 76,
    marginBottom: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  rowPressed: { borderColor: colors.primary, backgroundColor: '#EEF4FF' },
  name: { fontSize: 22, fontWeight: '700', color: colors.text },
  code: { fontSize: 16, fontWeight: '600', color: colors.muted, marginTop: 2 },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 18, color: colors.muted },
  notice: { paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: colors.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 480, alignSelf: 'center' },
  modalMeta: { marginTop: 8, fontSize: 16, color: colors.muted },
});
