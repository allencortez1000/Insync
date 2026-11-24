import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal, Textarea } from './ui';

interface PromptOptions {
  title: string;
  message?: ReactNode;
  label?: string;
  placeholder?: string;
  initial?: string;
  minLength?: number;
  multiline?: boolean;
  confirmText?: string;
  danger?: boolean;
}

interface Feedback {
  toast: (msg: string, tone?: 'ok' | 'error') => void;
  /** Ask for text (e.g. a reason). Resolves null when cancelled. */
  prompt: (opts: PromptOptions) => Promise<string | null>;
  confirm: (opts: Omit<PromptOptions, 'label' | 'minLength' | 'multiline' | 'placeholder' | 'initial'>) => Promise<boolean>;
  /** Runs an action, toasting success or the error message. Returns true on success. */
  run: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
}

const Ctx = createContext<Feedback | null>(null);

interface Toast { id: number; msg: string; tone: 'ok' | 'error' }
interface PromptState extends PromptOptions { mode: 'prompt' | 'confirm'; resolve: (v: string | null) => void }

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<PromptState | null>(null);
  const [text, setText] = useState('');
  const nextId = useRef(1);

  const toast = useCallback((msg: string, tone: 'ok' | 'error' = 'ok') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 3500);
  }, []);

  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => {
    setText(opts.initial ?? '');
    setDialog({ ...opts, mode: 'prompt', resolve });
  }), []);

  const confirm = useCallback((opts: PromptOptions) => new Promise<boolean>((resolve) => {
    setDialog({ ...opts, mode: 'confirm', resolve: (v) => resolve(v !== null) });
  }), []);

  const run = useCallback(async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast(success);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    }
  }, [toast]);

  const close = (v: string | null) => {
    dialog?.resolve(v);
    setDialog(null);
  };
  const min = dialog?.minLength ?? 0;
  const valid = dialog?.mode === 'confirm' || text.trim().length >= min;

  return (
    <Ctx.Provider value={{ toast, prompt, confirm, run }}>
      {children}
      <Modal
        open={dialog !== null}
        title={dialog?.title ?? ''}
        onClose={() => close(null)}
        footer={
          <>
            <Button onClick={() => close(null)}>Cancel</Button>
            <Button variant={dialog?.danger ? 'danger' : 'primary'} disabled={!valid} onClick={() => close(dialog?.mode === 'confirm' ? 'yes' : text.trim())}>
              {dialog?.confirmText ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {dialog?.message && <div className="text-sm text-gray-700">{dialog.message}</div>}
        {dialog?.mode === 'prompt' && (
          <Field label={dialog.label ?? 'Reason'} hint={min > 0 ? `Required (at least ${min} characters).` : undefined}>
            {dialog.multiline !== false
              ? <Textarea autoFocus value={text} placeholder={dialog.placeholder} onChange={(e) => setText(e.target.value)} />
              : <Input autoFocus value={text} placeholder={dialog.placeholder} onChange={(e) => setText(e.target.value)} />}
          </Field>
        )}
      </Modal>
      <div className="no-print fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-md px-4 py-3 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useFeedback(): Feedback {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFeedback must be used inside FeedbackProvider');
  return ctx;
}
