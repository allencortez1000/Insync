/** Web/PWA: react-native-web's Alert.alert is a no-op, so use the browser dialog. */
export function confirmAction(title: string, message: string, _cancelText: string, _okText: string, onOk: () => void, onCancel?: () => void) {
  if (window.confirm(`${title}\n\n${message}`)) onOk();
  else onCancel?.();
}
