import { useSyncExternalStore } from 'react';
import { useApp } from '../app-context.js';
import { Icon } from './Icon.js';

/** Confirmations for finished actions. Polite, so they never interrupt what is being read. */
export function Toasts() {
  const { toasts } = useApp();
  const items = useSyncExternalStore(toasts.subscribe, toasts.getState);

  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
    >
      {items.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-[0_20px_50px_-24px_rgba(0,0,0,0.9)] ${
            toast.tone === 'error' ? 'border-bad/40 bg-bad-soft text-bad-ink' : 'border-line-strong bg-surface text-ink'
          }`}
        >
          <span className="min-w-0 flex-1">{toast.message}</span>
          {toast.action !== undefined && (
            <button
              type="button"
              className="cursor-pointer rounded-lg px-2 py-1 font-semibold text-accent hover:bg-accent-soft"
              onClick={() => {
                toast.action?.run();
                toasts.dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="cursor-pointer rounded-lg p-1 text-muted hover:text-ink"
            onClick={() => toasts.dismiss(toast.id)}
          >
            <Icon name="close" className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
