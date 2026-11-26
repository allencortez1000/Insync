// The employee records their own face here; the site attendance device then recognises them at
// Clock In / Clock Out instead of asking for the PIN.
import { useEffect, useRef, useState } from 'react';
import { useAsync } from '../lib/hooks';
import { dateTime } from '../lib/format';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, ErrorBox, Notice, Spinner, cx } from '../components/ui';
import { Icon } from '../components/icons';
import { call } from './api';
import { CameraError, closeCamera, faceHint, goodFace, loadFaceApi, openCamera, readFace } from './face';

export interface FaceStatus { enrolled: boolean; samples: number; enrolled_at: string | null }
const PICTURES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function FaceCard() {
  const { run, confirm } = useFeedback();
  const status = useAsync(() => call<FaceStatus>('emp_face_status'), []);
  const [recording, setRecording] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const s = status.data;

  async function remove() {
    if (!(await confirm({ title: 'Remove your face?', confirmText: 'Remove', danger: true,
      message: 'You will clock in and out with your PIN again until you record your face.' }))) return;
    if (await run(() => call('emp_face_remove'), 'Face removed')) { setJustSaved(false); status.reload(); }
  }

  return (
    <Card title="Face for Clock In / Clock Out" actions={s && (s.enrolled ? <Badge tone="green">recorded</Badge> : <Badge tone="amber">not recorded yet</Badge>)}>
      <ErrorBox error={status.error} />
      {status.loading && !s ? <Spinner /> : recording ? (
        <FaceRecorder onCancel={() => setRecording(false)} onSaved={() => { setRecording(false); setJustSaved(true); status.reload(); }} />
      ) : (
        <div className="space-y-3 text-sm text-gray-700">
          {justSaved && <Notice tone="green">Your face is recorded. At your site, tap your name and look at the camera to clock in or out.</Notice>}
          {s?.enrolled ? (
            <p>Recorded {s.enrolled_at ? dateTime(s.enrolled_at) : ''}. On the attendance device at your site you now look at the camera instead of typing your PIN.</p>
          ) : (
            <p>Record your face once here. After that, on the attendance device at your site, you tap your name and look at the camera — no PIN needed.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => { setJustSaved(false); setRecording(true); }}>
              <Icon name="eye" className="h-4 w-4" />{s?.enrolled ? 'Record my face again' : 'Record my face'}
            </Button>
            {s?.enrolled && <Button onClick={() => void remove()}>Remove my face</Button>}
          </div>
          <p className="text-xs text-gray-500">
            No photo is saved. Your face is stored as a set of numbers that is used only to recognise you at Clock In and Clock Out.
            You can remove it any time, and the office can remove it too. Use good light, take off your cap, face mask and dark glasses.
          </p>
        </div>
      )}
    </Card>
  );
}

function FaceRecorder({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'starting' | 'looking' | 'saving' | 'error'>('starting');
  const [hint, setHint] = useState('Starting the camera…');
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    setPhase('starting'); setHint('Starting the camera…'); setCount(0); setError(null);

    (async () => {
      if (!video) return;
      try {
        const [api, opened] = await Promise.all([loadFaceApi(), openCamera(video, () => stopped)]);
        stream = opened;
        if (stopped) { closeCamera(stream, video); return; }
        setPhase('looking');
        const pictures: number[][] = [];
        let last = 0;
        while (!stopped && pictures.length < PICTURES) {
          const reading = await readFace(api, video);
          if (stopped) return;
          setHint(faceHint(reading));
          if (goodFace(reading) && Date.now() - last > 800) {
            pictures.push(reading.descriptor);
            last = Date.now();
            setCount(pictures.length);
          }
          await sleep(120);
        }
        if (stopped) return;
        setPhase('saving'); setHint('Saving…');
        await call('emp_face_enroll', { p_descriptors: pictures });
        closeCamera(stream, video);
        if (!stopped) onSaved();
      } catch (e) {
        closeCamera(stream, video);
        if (stopped) return;
        setError(e instanceof CameraError && e.kind === 'insecure'
          ? 'The camera only works on a secure (https) page. Open this website with https:// and try again.'
          : e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();

    return () => { stopped = true; closeCamera(stream, video); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className={cx('relative aspect-square w-full max-w-[18rem] overflow-hidden rounded-full border-4 bg-gray-900',
        phase === 'error' ? 'border-red-400' : count > 0 ? 'border-green-500' : 'border-brand-500')}>
        <video ref={videoRef} playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        {phase === 'starting' && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">Starting…</div>}
      </div>
      <div className="flex items-center gap-2" aria-label={`${count} of ${PICTURES} pictures taken`}>
        {Array.from({ length: PICTURES }, (_, i) => (
          <span key={i} className={cx('h-2.5 w-8 rounded-full', i < count ? 'bg-green-500' : 'bg-gray-200')} />
        ))}
      </div>
      {phase === 'error'
        ? <div className="w-full"><ErrorBox error={error} /></div>
        : <p className="text-center text-base font-semibold text-gray-900" role="status">{hint}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {phase === 'error' && <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
        <Button onClick={onCancel} disabled={phase === 'saving'}>Cancel</Button>
      </div>
    </div>
  );
}
