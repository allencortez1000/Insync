import { type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
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
import { Ionicons } from '@expo/vector-icons';
import type { Bi } from '../i18n';

/** One palette for the attendance app; brand blue matches the admin website. */
export const colors = {
  bg: '#F1F4F9',
  surface: '#FFFFFF',
  border: '#D5DCE6',
  borderStrong: '#B8C2D1',
  text: '#0B1220',
  muted: '#526075',
  primary: '#2459BD',
  primaryDark: '#1A3F86',
  primarySoft: '#E8F0FD',
  clockIn: '#12804A',
  clockOut: '#1E3A8A',
  danger: '#B42318',
  dangerBg: '#FEE4E2',
  warnBg: '#FEF0C7',
  warnText: '#7A2E0E',
  okBg: '#D1FADF',
  okText: '#054F31',
  infoBg: '#E0EAFF',
  infoText: '#1E3A8A',
  disabled: '#98A2B3',
};

export const MIN_TOUCH = 56;

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Icon({ name, size = 22, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} accessibilityElementsHidden importantForAccessibility="no" />;
}

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

const LOGO = require('../../assets/logo-mark.png');

/** Insync logo mark: a clock inside two sync arrows (brand/insync-mark.svg). */
export function BrandMark({ size = 44 }: { size?: number; inverted?: boolean }) {
  return <Image source={LOGO} style={{ width: size, height: size }} accessibilityLabel="Insync logo" />;
}

/** Round avatar with a person's initials. */
export function Avatar({ name, size = 48, color = colors.primary }: { name: string; size?: number; color?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => /^[A-Za-zÀ-ÿ]/.test(w))
    .map((w) => w[0]!.toUpperCase());
  const text = initials.length > 1 ? initials[0]! + initials[initials.length - 1]! : (initials[0] ?? '?');
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color, fontWeight: '800', fontSize: size * 0.38 }}>{text}</Text>
    </View>
  );
}

/** A UI label (English). */
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
  return (
    <View style={style}>
      <Text style={{ fontSize: size, color, textAlign: align, fontWeight: weight }}>{text.en}</Text>
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
  icon,
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
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const height = size === 'xl' ? 104 : size === 'lg' ? 64 : MIN_TOUCH;
  const fontSize = size === 'xl' ? 28 : size === 'lg' ? 20 : 17;
  const solid = variant === 'solid';
  const inactive = disabled || busy;
  const fg = solid ? textColor : color;
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
          borderColor: solid ? 'transparent' : inactive ? colors.border : color,
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
        solid && !inactive && styles.buttonShadow,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} size="large" />
      ) : (
        <View style={styles.buttonInner}>
          {icon && <Icon name={icon} size={Math.round(fontSize * 1.15)} color={inactive && !solid ? colors.disabled : fg} />}
          <Text style={{ fontSize, color: inactive && !solid ? colors.disabled : fg, fontWeight: '700', textAlign: 'center', flexShrink: 1 }}>
            {label.en}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function Banner({ text, tone = 'warn' }: { text: Bi; tone?: 'warn' | 'danger' | 'ok' | 'info' }) {
  const bg = tone === 'danger' ? colors.dangerBg : tone === 'ok' ? colors.okBg : tone === 'info' ? colors.infoBg : colors.warnBg;
  const fg = tone === 'danger' ? colors.danger : tone === 'ok' ? colors.okText : tone === 'info' ? colors.infoText : colors.warnText;
  const icon: IconName = tone === 'danger' ? 'alert-circle' : tone === 'ok' ? 'checkmark-circle' : tone === 'info' ? 'information-circle' : 'warning';
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="alert">
      <Icon name={icon} size={20} color={fg} />
      <Text style={{ flex: 1, fontSize: 15, color: fg, fontWeight: '600', lineHeight: 21 }}>{text.en}</Text>
    </View>
  );
}

export function ConnectionPill({ online, compact = false }: { online: boolean; compact?: boolean }) {
  return (
    <View
      style={[styles.pill, compact && styles.pillCompact, { backgroundColor: online ? colors.okBg : colors.dangerBg }]}
      accessibilityLabel={online ? 'Online' : 'Offline'}
    >
      <Icon name={online ? 'wifi' : 'cloud-offline'} size={16} color={online ? colors.okText : colors.danger} />
      {!compact && <Text style={{ color: online ? colors.okText : colors.danger, fontWeight: '700', fontSize: 14 }}>{online ? 'Online' : 'Offline'}</Text>}
    </View>
  );
}

/** Big round icon used at the top of full-screen states. */
export function StateIcon({ name, color, background, size = 96 }: { name: IconName; color: string; background: string; size?: number }) {
  return (
    <View style={{ alignSelf: 'center', width: size, height: size, borderRadius: size / 2, backgroundColor: background, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={name} size={size * 0.58} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  button: {
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  buttonShadow: {
    shadowColor: '#0B1220',
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  buttonInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, maxWidth: '100%' },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 6,
  },
  pillCompact: { paddingHorizontal: 9, paddingVertical: 9 },
});
