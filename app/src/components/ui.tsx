import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Bi } from '../i18n';

export const colors = {
  bg: '#F3F5F8',
  surface: '#FFFFFF',
  border: '#CBD2DC',
  text: '#0B1220',
  muted: '#475467',
  primary: '#1D4ED8',
  clockIn: '#11703A',
  clockOut: '#1E3A8A',
  danger: '#B42318',
  dangerBg: '#FEE4E2',
  warnBg: '#FEF0C7',
  warnText: '#7A2E0E',
  okBg: '#D1FADF',
  okText: '#054F31',
  disabled: '#98A2B3',
};

export const MIN_TOUCH = 56;

/** True on tablets / wide windows. */
export function useIsWide(): boolean {
  const { width } = useWindowDimensions();
  return width >= 700;
}

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <SafeAreaView style={[styles.screen, style]} edges={['top', 'bottom', 'left', 'right']}>
      {children}
    </SafeAreaView>
  );
}

/** English line + Filipino line. */
export function BiText({
  text,
  size = 18,
  color = colors.text,
  align = 'left',
  weight = '600',
  style,
}: {
  text: Bi;
  size?: number;
  color?: string;
  align?: TextStyle['textAlign'];
  weight?: TextStyle['fontWeight'];
  style?: StyleProp<ViewStyle>;
}) {
  const same = text.en === text.fil;
  return (
    <View style={style}>
      <Text style={{ fontSize: size, color, textAlign: align, fontWeight: weight }}>{text.en}</Text>
      {!same && (
        <Text style={{ fontSize: Math.max(13, Math.round(size * 0.72)), color, opacity: 0.8, textAlign: align, marginTop: 2 }}>
          {text.fil}
        </Text>
      )}
    </View>
  );
}

export function BigButton({
  label,
  onPress,
  color = colors.primary,
  textColor = '#FFFFFF',
  disabled,
  busy,
  size = 'lg',
  variant = 'solid',
  style,
  accessibilityLabel,
}: {
  label: Bi;
  onPress: () => void;
  color?: string;
  textColor?: string;
  disabled?: boolean;
  busy?: boolean;
  size?: 'md' | 'lg' | 'xl';
  variant?: 'solid' | 'outline';
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const height = size === 'xl' ? 112 : size === 'lg' ? 72 : MIN_TOUCH;
  const fontSize = size === 'xl' ? 30 : size === 'lg' ? 22 : 18;
  const solid = variant === 'solid';
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label.en}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: height,
          backgroundColor: solid ? (inactive ? colors.disabled : color) : colors.surface,
          borderColor: solid ? 'transparent' : color,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={solid ? textColor : color} size="large" />
      ) : (
        <BiText text={label} size={fontSize} color={solid ? textColor : color} align="center" weight="700" />
      )}
    </Pressable>
  );
}

export function Banner({ text, tone = 'warn' }: { text: Bi; tone?: 'warn' | 'danger' | 'ok' | 'info' }) {
  const bg = tone === 'danger' ? colors.dangerBg : tone === 'ok' ? colors.okBg : tone === 'info' ? '#E0EAFF' : colors.warnBg;
  const fg = tone === 'danger' ? colors.danger : tone === 'ok' ? colors.okText : tone === 'info' ? '#1E3A8A' : colors.warnText;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="alert">
      <BiText text={text} size={16} color={fg} weight="600" />
    </View>
  );
}

export function ConnectionPill({ online }: { online: boolean }) {
  return (
    <View
      style={[styles.pill, { backgroundColor: online ? colors.okBg : colors.dangerBg }]}
      accessibilityLabel={online ? 'Online' : 'Offline'}
    >
      <View style={[styles.dot, { backgroundColor: online ? '#12B76A' : colors.danger }]} />
      <Text style={{ color: online ? colors.okText : colors.danger, fontWeight: '700', fontSize: 14 }}>
        {online ? 'Online' : 'Offline · Walang koneksyon'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  button: {
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  banner: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 6,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
