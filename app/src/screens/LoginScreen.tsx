import { useState } from 'react';
import {
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Constants from 'expo-constants';
import { Banner, BigButton, BrandMark, Icon, Screen, colors, type IconName } from '../components/ui';
import { errorText, t, type Bi } from '../i18n';
import { siteLogin } from '../lib/api';
import { saveSession, type StoredSession } from '../lib/storage';
import { supabaseConfigured } from '../lib/supabase';

const PHOTO = require('../../assets/login-site.jpg');
const PHOTO_CREDIT = 'Photo: Josh Olalde / Unsplash';

const FEATURES: { icon: IconName; text: string }[] = [
  { icon: 'keypad-outline', text: 'Employees clock in and out with their own PIN.' },
  { icon: 'location-outline', text: 'Location is recorded only at Clock In and Clock Out.' },
  { icon: 'shield-checkmark-outline', text: 'Every record is checked by the server before it is saved.' },
];

/** On the web build, the admin website lives on the same domain at "/" (rendered as a real <a href="/">). */
const ADMIN_LINK = { href: '/' } as object;

export function LoginScreen({
  notice,
  onLoggedIn,
}: {
  notice?: Bi;
  onLoggedIn: (session: StoredSession) => void;
}) {
  const { width } = useWindowDimensions();
  const split = width >= 900;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState<'user' | 'pass' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Bi | null>(null);

  const canSubmit = supabaseConfigured && username.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await siteLogin(username.trim(), password, {
      label: Constants.deviceName ?? undefined,
      platform: Platform.OS,
      appVersion: Constants.expoConfig?.version,
    });
    if (result.kind === 'ok') {
      const session: StoredSession = {
        token: result.data.token,
        site: result.data.site,
        policy: result.data.policy,
      };
      try {
        await saveSession(session);
      } catch {
        // Secure storage failure: the session still works until the app restarts.
      }
      setPassword('');
      setBusy(false);
      onLoggedIn(session);
      return;
    }
    setBusy(false);
    setPassword('');
    if (result.kind === 'fail') setError(errorText(result.failure.code));
    else if (result.kind === 'network') setError(t.networkError);
    else setError(t.serverError);
  }

  const form = (
    <View style={[styles.card, split && styles.cardSplit]}>
      {split && (
        <View style={styles.formBrand}>
          <BrandMark size={52} />
          <View style={styles.chip}>
            <Text style={styles.chipText}>Site attendance</Text>
          </View>
        </View>
      )}
      <Text style={styles.heading}>{t.siteSignIn.en}</Text>
      <Text style={styles.hint}>{t.siteSignInHint.en}</Text>

      {!supabaseConfigured && (
        <View style={styles.gap}>
          <Banner text={t.notConfigured} tone="danger" />
        </View>
      )}
      {notice && (
        <View style={styles.gap}>
          <Banner text={notice} tone="warn" />
        </View>
      )}

      <View style={styles.gap}>
        <Text style={styles.label}>{t.username.en}</Text>
        <View style={[styles.inputWrap, focused === 'user' && styles.inputFocused]}>
          <Icon name="business-outline" size={22} color={focused === 'user' ? colors.primary : colors.muted} />
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            onFocus={() => setFocused('user')}
            onBlur={() => setFocused(null)}
            autoCapitalize="words"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            placeholder="e.g. Makati Warehouse"
            placeholderTextColor="#8A94A6"
            returnKeyType="next"
            editable={!busy}
            accessibilityLabel="Site name"
          />
        </View>
      </View>
      <View style={styles.gap}>
        <Text style={styles.label}>{t.password.en}</Text>
        <View style={[styles.inputWrap, focused === 'pass' && styles.inputFocused]}>
          <Icon name="lock-closed-outline" size={22} color={focused === 'pass' ? colors.primary : colors.muted} />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            onFocus={() => setFocused('pass')}
            onBlur={() => setFocused(null)}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            textContentType="password"
            placeholder="Site password"
            placeholderTextColor="#8A94A6"
            returnKeyType="go"
            onSubmitEditing={submit}
            editable={!busy}
            accessibilityLabel="Site password"
          />
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            hitSlop={10}
            style={styles.eye}
          >
            <Icon name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
          </Pressable>
        </View>
      </View>

      {error && (
        <View style={styles.gap}>
          <Banner text={error} tone="danger" />
        </View>
      )}

      <BigButton
        label={busy ? t.signingIn : t.signIn}
        onPress={submit}
        disabled={!canSubmit}
        busy={busy}
        icon="log-in-outline"
        style={{ marginTop: 24 }}
      />

      {Platform.OS === 'web' && (
        <Pressable accessibilityRole="link" style={styles.adminLink} hitSlop={6} {...ADMIN_LINK}>
          <Icon name="grid-outline" size={16} color={colors.primary} />
          <Text style={styles.adminLinkText}>Admin or HR? Open the admin website</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <Screen style={split ? { backgroundColor: colors.surface } : undefined}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {split ? (
          <View style={styles.split}>
            <ImageBackground source={PHOTO} resizeMode="cover" style={styles.hero}>
              <View style={styles.heroShade} />
              <View style={styles.heroTop}>
                <BrandMark size={52} />
                <View>
                  <Text style={styles.heroBrand}>Insync</Text>
                  <Text style={styles.heroBrandSub}>Site attendance</Text>
                </View>
              </View>
              <View style={{ gap: 18, maxWidth: 460 }}>
                <Text style={styles.heroTitle}>Clock in at every site, in seconds.</Text>
                <Text style={styles.heroText}>Sign in this shared device once. Then each employee taps their name and enters their PIN.</Text>
                <View style={{ gap: 14, marginTop: 8 }}>
                  {FEATURES.map((f) => (
                    <View key={f.icon} style={styles.feature}>
                      <View style={styles.featureIcon}>
                        <Icon name={f.icon} size={20} color="#FFFFFF" />
                      </View>
                      <Text style={styles.featureText}>{f.text}</Text>
                    </View>
                  ))}
                </View>
              </View>
              <Text style={styles.heroFoot}>{PHOTO_CREDIT}</Text>
            </ImageBackground>
            <ScrollView contentContainerStyle={styles.splitForm} keyboardShouldPersistTaps="handled">
              {form}
            </ScrollView>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scrollCompact} keyboardShouldPersistTaps="handled">
            <ImageBackground source={PHOTO} resizeMode="cover" style={styles.banner}>
              <View style={styles.bannerShade} />
              <View style={styles.bannerInner}>
                <View style={styles.heroTop}>
                  <BrandMark size={52} />
                  <View>
                    <Text style={styles.heroBrand}>Insync</Text>
                    <Text style={styles.heroBrandSub}>Site attendance</Text>
                  </View>
                </View>
                <Text style={styles.bannerText}>Clock in at every site, in seconds.</Text>
              </View>
            </ImageBackground>
            <View style={styles.compactForm}>{form}</View>
            <Text style={styles.credit}>{PHOTO_CREDIT}</Text>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scrollCompact: { flexGrow: 1 },
  banner: { height: 230, justifyContent: 'center', overflow: 'hidden' },
  bannerShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20,48,104,0.62)' },
  bannerInner: { paddingHorizontal: 24, paddingBottom: 36, width: '100%', maxWidth: 492, alignSelf: 'center' },
  bannerText: { color: '#FFFFFF', fontSize: 15, marginTop: 12, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  compactForm: { marginTop: -40, paddingHorizontal: 16, alignItems: 'center' },
  credit: { textAlign: 'center', color: '#98A2B3', fontSize: 11, paddingVertical: 16 },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20,48,104,0.58)' },
  heroBrandSub: { color: '#EEF4FE', fontSize: 14, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  formBrand: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 22 },
  chip: { backgroundColor: colors.primarySoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  split: { flex: 1, flexDirection: 'row' },
  hero: {
    flex: 1,
    maxWidth: 760,
    padding: 48,
    overflow: 'hidden',
    justifyContent: 'space-between',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroBrand: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', letterSpacing: 0.5, textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  heroTitle: { color: '#FFFFFF', fontSize: 40, fontWeight: '800', lineHeight: 48, textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  heroText: { color: '#EEF4FE', fontSize: 18, lineHeight: 27, textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  featureIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  featureText: { color: '#FFFFFF', fontSize: 16, flex: 1, lineHeight: 22 },
  heroFoot: { color: '#EEF4FE', fontSize: 12, opacity: 0.85 },
  splitForm: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: colors.surface,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0B1220',
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  cardSplit: { borderWidth: 0, shadowOpacity: 0, elevation: 0, padding: 8 },
  heading: { fontSize: 28, fontWeight: '800', color: colors.text },
  hint: { fontSize: 15, color: colors.muted, marginTop: 6, lineHeight: 21 },
  gap: { marginTop: 18 },
  label: { fontSize: 15, fontWeight: '700', color: colors.text },
  inputWrap: {
    marginTop: 8,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 14,
    paddingLeft: 14,
    paddingRight: 6,
    backgroundColor: '#FFFFFF',
  },
  inputFocused: { borderColor: colors.primary },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    fontSize: 18,
    color: colors.text,
    // react-native-web: remove the browser focus ring; the wrapper shows focus.
    outlineStyle: 'none',
  } as object,
  eye: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  adminLink: { marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  adminLinkText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
});
