// Face recognition in the browser (face-api.js). The camera picture never leaves the device:
// it is turned into a face template (128 numbers) here, and only that template is sent to the
// server, which does the comparison. Web build only; same helper as admin/src/portal/face.ts.


type FaceApi = any;
declare global { interface Window { faceapi?: FaceApi } }

// The admin website serves the engine at /face (same origin as /site in production and in `npm run dev`).
const LOCAL = '/face';
/** Face check is available in the web / PWA build. */
export const faceSupported = true;
const CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15';

export interface FaceReading {
  /** 128-number face template. */
  descriptor: number[];
  /** Detector confidence, 0..1. */
  score: number;
  /** Face width as a share of the picture width, 0..1. */
  size: number;
  /** How far the face centre is from the picture centre, 0 = centred. */
  offCentre: number;
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { el.remove(); reject(new Error(`could not load ${src}`)); };
    document.head.appendChild(el);
  });
}

// Detector input size. 320 places the face more precisely than 224, which gives a more reliable template.
const DETECT_SIZE = 320;

let ready: Promise<FaceApi> | null = null;

/** Starts loading the engine in the background (call it as soon as a face check is likely). */
export function preloadFaceApi(): void {
  void loadFaceApi().catch(() => undefined);
}

/** Loads the engine and its models once (about 7 MB the first time, then cached by the browser). */
export function loadFaceApi(): Promise<FaceApi> {
  ready ??= (async () => {
    let models = `${LOCAL}/models`;
    if (!window.faceapi) {
      try {
        await injectScript(`${LOCAL}/face-api.js`);
      } catch {
        await injectScript(`${CDN}/dist/face-api.js`);
        models = `${CDN}/model`;
      }
    }
    const api = window.faceapi;
    if (!api) throw new Error('The face engine did not start.');
    await Promise.all([
      api.nets.tinyFaceDetector.loadFromUri(models),
      api.nets.faceLandmark68Net.loadFromUri(models),
      api.nets.faceRecognitionNet.loadFromUri(models),
    ]);
    // Run each model once on a blank picture so the slow first run (the graphics card compiles the
    // models) happens now, in the background, instead of while the person is waiting at the camera.
    try {
      const blank = document.createElement('canvas');
      blank.width = 160;
      blank.height = 160;
      blank.getContext('2d')?.fillRect(0, 0, 160, 160);
      await api.detectAllFaces(blank, new api.TinyFaceDetectorOptions({ inputSize: DETECT_SIZE, scoreThreshold: 0.5 }));
      await api.nets.faceLandmark68Net.detectLandmarks(blank);
      await api.nets.faceRecognitionNet.computeFaceDescriptor(blank);
    } catch { /* warm-up is only an optimisation */ }
    return api;
  })().catch((e: unknown) => { ready = null; throw e; });
  return ready;
}

export class CameraError extends Error {
  constructor(public kind: 'insecure' | 'denied' | 'none' | 'other', message: string) { super(message); }
}

/**
 * Opens the front camera into a <video>. Phone browsers allow this only on https pages.
 * `cancelled` lets a screen that was closed in the meantime give the camera straight back
 * without touching a <video> that a newer screen is already using.
 */
export async function openCamera(video: HTMLVideoElement, cancelled: () => boolean = () => false): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('insecure', 'The camera only works on a secure (https) page.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', 'Camera permission was not given. Allow the camera for this site and try again.');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('none', 'No camera was found on this device.');
    throw new CameraError('other', 'The camera could not be opened. Close other apps that use it and try again.');
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  if (cancelled()) {
    release();
    throw new CameraError('other', 'cancelled');
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    release();
    if (video.srcObject === stream) video.srcObject = null;
    throw new CameraError('other', 'The camera could not be started. Please try again.');
  }
  return stream;
}

/** Stops the camera. The <video> is cleared only if it is still showing this stream. */
export function closeCamera(stream: MediaStream | null, video?: HTMLVideoElement | null) {
  stream?.getTracks().forEach((t) => t.stop());
  if (stream && video && video.srcObject === stream) video.srcObject = null;
}

/** Looks for exactly one face in the current video frame. Null when no face is found. */
export async function readFace(api: FaceApi, video: HTMLVideoElement): Promise<FaceReading | null> {
  if (!video.videoWidth) return null;
  const found = await api
    .detectSingleFace(video, new api.TinyFaceDetectorOptions({ inputSize: DETECT_SIZE, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!found) return null;
  const box = found.detection.box;
  const cx = (box.x + box.width / 2) / video.videoWidth - 0.5;
  const cy = (box.y + box.height / 2) / video.videoHeight - 0.5;
  return {
    descriptor: Array.from(found.descriptor as Float32Array, (v) => Math.round(v * 1e5) / 1e5),
    score: found.detection.score,
    size: box.width / video.videoWidth,
    offCentre: Math.hypot(cx, cy),
  };
}

/** Good enough to use: confident detection, close to the camera, roughly in the middle. */
export function goodFace(r: FaceReading | null): r is FaceReading {
  return !!r && r.score >= 0.65 && r.size >= 0.25 && r.offCentre <= 0.25;
}

/** Short instruction for the person in front of the camera. */
export function faceHint(r: FaceReading | null): string {
  if (!r) return 'Put your face inside the circle';
  if (r.size < 0.25) return 'Move closer to the camera';
  if (r.offCentre > 0.25) return 'Move your face to the middle';
  if (r.score < 0.65) return 'Face the camera, in good light';
  return 'Hold still…';
}
