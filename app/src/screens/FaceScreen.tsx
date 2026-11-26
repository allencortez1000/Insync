// Native builds have no face check (see src/lib/face.ts); the web / PWA build uses FaceScreen.web.tsx.
import type { Bi } from '../i18n';
import type { RosterEmployee } from '../lib/api';

/** Outcome of sending one face template to the server. */
export type FaceResult =
  | { kind: 'done' }                 // the flow moved on (confirmed, or a message screen is showing)
  | { kind: 'mismatch' }             // not the recorded face: keep looking
  | { kind: 'error'; lines: Bi[] };  // show these lines and keep looking

export function FaceScreen(_props: {
  employee: RosterEmployee;
  notice?: Bi;
  onVerify: (descriptor: number[]) => Promise<FaceResult>;
  onUsePin?: () => void;
  onBack: () => void;
}) {
  return null;
}
