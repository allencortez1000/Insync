import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Icon, colors, useIsWide } from './ui';

type Key = { kind: 'digit'; value: string } | { kind: 'clear' } | { kind: 'back' };

const KEYS: Key[] = [
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((value) => ({ kind: 'digit', value }) as Key),
  { kind: 'clear' },
  { kind: 'digit', value: '0' },
  { kind: 'back' },
];

/** Large numeric keypad. No system keyboard is ever shown for the PIN. */
export function Keypad({
  onDigit,
  onClear,
  onBackspace,
  disabled,
}: {
  onDigit: (digit: string) => void;
  onClear: () => void;
  onBackspace: () => void;
  disabled?: boolean;
}) {
  const wide = useIsWide();
  const { height } = useWindowDimensions();
  // Shrink keys on short screens so the whole PIN screen fits without scrolling.
  const keyHeight = Math.max(54, Math.min(wide ? 88 : 72, Math.floor((height - 430) / 4.4)));

  return (
    <View style={[styles.grid, { maxWidth: wide ? 440 : 360 }]}>
      {KEYS.map((key, index) => {
        const label = key.kind === 'digit' ? key.value : 'Clear';
        const a11y = key.kind === 'digit' ? key.value : key.kind === 'clear' ? 'Clear PIN' : 'Delete last digit';
        const onPress = key.kind === 'digit' ? () => onDigit(key.value) : key.kind === 'clear' ? onClear : onBackspace;
        return (
          <View key={index} style={styles.cell}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={a11y}
              disabled={disabled}
              onPress={onPress}
              style={({ pressed }) => [
                styles.key,
                { height: keyHeight },
                key.kind !== 'digit' && styles.keyAlt,
                pressed && styles.keyPressed,
                disabled && styles.keyDisabled,
              ]}
            >
              {key.kind === 'back' ? (
                <Icon name="backspace-outline" size={30} color={colors.text} />
              ) : (
                <Text style={[styles.keyText, { fontSize: key.kind === 'digit' ? (wide ? 36 : 30) : 16 }]}>{label}</Text>
              )}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { width: '100%', alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '33.333%', padding: 6 },
  key: {
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyAlt: { backgroundColor: '#E9EDF3' },
  keyPressed: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  keyDisabled: { opacity: 0.5 },
  keyText: { color: colors.text, fontWeight: '700' },
});
