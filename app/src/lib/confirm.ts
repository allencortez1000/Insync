import { Alert } from 'react-native';

/** Two-button confirm. Native: Alert dialog. Web build uses confirm.web.ts. */
export function confirmAction(title: string, message: string, cancelText: string, okText: string, onOk: () => void, onCancel?: () => void) {
  Alert.alert(title, message, [
    { text: cancelText, style: 'cancel', onPress: onCancel },
    { text: okText, style: 'destructive', onPress: onOk },
  ]);
}
