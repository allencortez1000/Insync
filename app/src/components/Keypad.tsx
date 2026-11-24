import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, useIsWide } from './ui';

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
  const keyHeight = wide ? 96 : 76;

  return (
    <View style={[styles.grid, { maxWidth: wide ? 440 : 360 }]}>
      {KEYS.map((key, index) => {
        const label = key.kind === 'digit' ? key.value : key.kind === 'clear' ? 'Clear\nBurahin' : '⌫';
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
              <Text
                style={[
                  styles.keyText,
                  key.kind === 'clear' && styles.keyTextSmall,
                  { fontSize: key.kind === 'digit' ? (wide ? 38 : 32) : key.kind === 'back' ? 30 : 15 },
                ]}
              >
                {label}
              </Text>
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
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyAlt: { backgroundColor: '#E4E7EC' },
  keyPressed: { backgroundColor: '#C7D7FE', borderColor: colors.primary },
  keyDisabled: { opacity: 0.5 },
  keyText: { color: colors.text, fontWeight: '700' },
  keyTextSmall: { textAlign: 'center', lineHeight: 18 },
});
