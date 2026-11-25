import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { Avatar, Banner, BigButton, BrandMark, ConnectionPill, Icon, MIN_TOUCH, Screen, colors } from '../components/ui';
import { t, type Bi } from '../i18n';
import type { RosterEmployee, Site, SitePolicy } from '../lib/api';
import { confirmAction } from '../lib/confirm';

function fold(value: string): string {
  let s = value.toLowerCase();
  try {
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // normalize unsupported: plain lowercase match
  }
  return s;
}

const MAX_CONTENT = 1240;

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
  const content = Math.min(width, MAX_CONTENT);
  const columns = content >= 1100 ? 3 : content >= 700 ? 2 : 1;
  const compact = width < 420;
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const filtered = useMemo(() => {
    const list = employees ?? [];
    const q = fold(query.trim());
    if (!q) return list;
    return list.filter((e) => fold(e.name).includes(q) || fold(e.code).includes(q) || fold(`${e.last_name} ${e.first_name}`).includes(q));
  }, [employees, query]);

  function confirmSignOut() {
    confirmAction(t.signOut.en, t.signOutConfirm.en, t.cancel.en, t.signOut.en, () => {
      setSettingsOpen(false);
      onSignOut();
    });
  }

  return (
    <Screen>
      <View style={styles.headerBar}>
        <View style={styles.header}>
          <View style={styles.siteBlock} accessibilityLabel={`Site ${site.name}`}>
            <BrandMark size={compact ? 38 : 44} />
            <View style={{ flexShrink: 1 }}>
              <Text style={[styles.siteName, compact && { fontSize: 18 }]} numberOfLines={1}>
                {site.name}
              </Text>
              <Text style={styles.siteCode} numberOfLines={1}>
                {site.code}
              </Text>
            </View>
          </View>
          <ConnectionPill online={online} compact={compact} />
          <Pressable
            onPress={() => setSettingsOpen(true)}
            style={({ pressed }) => [styles.gear, !compact && styles.gearWide, pressed && { backgroundColor: colors.primarySoft }]}
            accessibilityRole="button"
            accessibilityLabel="Device settings"
            accessibilityHint="Opens settings, including Sign out"
            hitSlop={8}
          >
            <Icon name="settings-outline" size={22} color={colors.muted} />
            {!compact && <Text style={styles.gearText}>Settings</Text>}
          </Pressable>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t.selectName.en}</Text>
          {employees && employees.length > 0 && (
            <Text style={styles.count}>
              {filtered.length} of {employees.length}
            </Text>
          )}
        </View>
        <View style={styles.searchWrap}>
          <Icon name="search" size={22} color={colors.muted} />
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder={t.search.en}
            placeholderTextColor="#8A94A6"
            autoCorrect={false}
            autoCapitalize="words"
            clearButtonMode="while-editing"
            returnKeyType="search"
            accessibilityLabel="Search name or employee code"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} style={styles.clear}>
              <Icon name="close-circle" size={22} color={colors.muted} />
            </Pressable>
          )}
        </View>

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
              <Avatar name={item.name} size={48} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={styles.code} numberOfLines={1}>
                  {item.code}
                </Text>
              </View>
              <Icon name="chevron-forward" size={22} color={colors.borderStrong} />
            </Pressable>
          )}
          ListEmptyComponent={
            employees === null ? (
              <View style={styles.emptyBox}>{loading && <ActivityIndicator size="large" color={colors.primary} />}</View>
            ) : (
              <View style={styles.emptyBox}>
                <Icon name={query ? 'search-outline' : 'people-outline'} size={44} color={colors.borderStrong} />
                <Text style={styles.empty}>{(query ? t.noMatches : t.noEmployees).en}</Text>
              </View>
            )
          }
        />

        <View style={styles.notice}>
          <Icon name="location-outline" size={18} color={colors.muted} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.noticeText}>{t.locationNotice.en}</Text>
            <Text style={styles.noticeText}>
              {(policy.location_failure_policy === 'block' ? t.locationRequiredNotice : t.locationReviewNotice).en}
            </Text>
          </View>
        </View>
      </View>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHead}>
              <Icon name="settings-outline" size={26} color={colors.text} />
              <Text style={styles.modalTitle}>{t.settings.en}</Text>
            </View>
            <View style={styles.modalSite}>
              <BrandMark size={36} />
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.modalSiteName} numberOfLines={2}>
                  {site.name}
                </Text>
                <Text style={styles.siteCode}>{site.code}</Text>
              </View>
            </View>
            <Text style={styles.modalNote}>Signing out removes this device from the site. Signing in again needs the site name and site password.</Text>
            <BigButton label={t.signOut} onPress={confirmSignOut} color={colors.danger} icon="log-out-outline" style={{ marginTop: 20 }} />
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
  headerBar: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  header: {
    width: '100%',
    maxWidth: MAX_CONTENT,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  siteBlock: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  siteName: { fontSize: 20, fontWeight: '800', color: colors.text },
  siteCode: { fontSize: 13, color: colors.muted, fontWeight: '600', marginTop: 1 },
  gear: { minWidth: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  gearWide: { paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border },
  gearText: { fontSize: 15, fontWeight: '600', color: colors.muted },
  body: { flex: 1, width: '100%', maxWidth: MAX_CONTENT, alignSelf: 'center', padding: 16, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  title: { fontSize: 24, fontWeight: '800', color: colors.text },
  count: { fontSize: 14, color: colors.muted, fontWeight: '600' },
  searchWrap: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 14,
    paddingLeft: 14,
    paddingRight: 6,
    backgroundColor: colors.surface,
  },
  search: { flex: 1, minWidth: 0, minHeight: 52, fontSize: 18, color: colors.text, outlineStyle: 'none' } as object,
  clear: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  row: {
    minHeight: MIN_TOUCH + 20,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  rowPressed: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  name: { fontSize: 19, fontWeight: '700', color: colors.text },
  code: { fontSize: 14, fontWeight: '600', color: colors.muted, marginTop: 2 },
  emptyBox: { alignItems: 'center', gap: 12, marginTop: 40 },
  empty: { textAlign: 'center', fontSize: 17, color: colors.muted, fontWeight: '600' },
  notice: { flexDirection: 'row', gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  noticeText: { fontSize: 13, color: colors.muted, fontWeight: '500', lineHeight: 18 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(11,18,32,0.5)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: colors.surface, borderRadius: 24, padding: 24, width: '100%', maxWidth: 440, alignSelf: 'center' },
  modalHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modalTitle: { fontSize: 22, fontWeight: '800', color: colors.text },
  modalSite: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, padding: 12, borderRadius: 14, backgroundColor: colors.bg },
  modalNote: { marginTop: 14, fontSize: 14, lineHeight: 20, color: colors.muted },
  modalSiteName: { fontSize: 17, fontWeight: '700', color: colors.text },
});
