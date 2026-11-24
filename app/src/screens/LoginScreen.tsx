import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { Banner, BigButton, BiText, Screen, colors } from '../components/ui';
import { errorText, t, type Bi } from '../i18n';
import { siteLogin } from '../lib/api';
import { saveSession, type StoredSession } from '../lib/storage';
import { supabaseConfigured } from '../lib/supabase';

export function LoginScreen({
  notice,
  onLoggedIn,
}: {
  notice?: Bi;
  onLoggedIn: (session: StoredSession) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.brand}>Insync</Text>
            <BiText text={t.siteSignIn} size={26} weight="800" />
            <BiText text={t.siteSignInHint} size={15} color={colors.muted} weight="400" style={{ marginTop: 8 }} />

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
              <BiText text={t.username} size={16} />
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="words"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                placeholder="e.g. Makati Warehouse"
                returnKeyType="next"
                editable={!busy}
                accessibilityLabel="Site name"
              />
            </View>
            <View style={styles.gap}>
              <BiText text={t.password} size={16} />
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!busy}
                accessibilityLabel="Site password"
              />
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
              style={{ marginTop: 24 }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  brand: { fontSize: 15, fontWeight: '800', color: colors.primary, letterSpacing: 1.5, marginBottom: 6 },
  gap: { marginTop: 18 },
  input: {
    marginTop: 8,
    minHeight: 56,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 20,
    color: colors.text,
    backgroundColor: '#FFFFFF',
  },
});
