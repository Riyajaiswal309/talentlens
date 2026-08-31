import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { CheckIcon, CloseIcon } from './icons';

/**
 * Transient success feedback.
 *
 * WHY THIS EXISTS. Most mutations in this app confirm themselves by changing
 * what is on screen — a moved pipeline card, a new comment in the thread, a
 * saved weighting that prints its own `rescoreStatus`. Two do not: publishing
 * and closing a job only flip a badge, which is easy to miss and leaves the
 * recruiter unsure whether an irreversible action actually landed.
 *
 * SUCCESS ONLY, DELIBERATELY. Failures already have a home — `ErrorState`
 * renders the server's own RFC 7807 `detail` inline, next to the control that
 * failed, and stays until dealt with. Routing errors into a toast that vanishes
 * after four seconds would make them easier to miss, not harder.
 *
 * ANNOUNCED, NOT JUST DRAWN. The region is `role="status"` with
 * `aria-live="polite"`, so a screen-reader user hears the confirmation rather
 * than only sighted users seeing it (NFR4). `polite` rather than `assertive`
 * because a success message must not interrupt whatever is being read.
 */
interface Toast {
  id: number;
  message: string;
}

interface ToastContextValue {
  /** Show a success confirmation. Keep it to one short sentence. */
  notify: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** How long a confirmation stays. Long enough to read, short enough to ignore. */
const TOAST_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message }]);
      const timer = window.setTimeout(() => dismiss(id), TOAST_MS);
      timers.current.push(timer);
    },
    [dismiss],
  );

  // Clearing on unmount stops a timer firing into a dead component.
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(window.clearTimeout);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/*
        The region is always mounted, even when empty. A live region added to
        the DOM at the same moment as its content is frequently not announced —
        assistive technology has to be observing it beforehand.
      */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex w-full max-w-sm animate-fade-in-up items-start gap-3 rounded-lg border border-neutral-200 bg-neutral-0 p-4 shadow-lg"
          >
            <span className="mt-0.5 shrink-0 rounded-full bg-success-50 p-1 text-success-700">
              <CheckIcon className="h-4 w-4" />
            </span>
            <p className="flex-1 text-sm text-neutral-900">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="-m-1 shrink-0 rounded-sm p-1 text-neutral-400 transition-colors hover:text-neutral-900"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Show a success confirmation.
 *
 * Returns a no-op outside the provider rather than throwing: a missing toast is
 * a cosmetic loss, and crashing a page over one would be a worse trade.
 */
export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? { notify: () => {} };
}
