// Native builds (Expo Go / store apps): the face check is not available, employees use the PIN.
// The web / PWA build uses face.web.ts.
export const faceSupported = false;

export function preloadFaceApi(): void {
  // nothing to load on native builds
}

export interface FaceReading { descriptor: number[]; score: number; size: number; offCentre: number }
export class CameraError extends Error {
  constructor(public kind: 'insecure' | 'denied' | 'none' | 'other', message: string) { super(message); }
}
