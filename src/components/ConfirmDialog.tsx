import { useEffect, useRef, type ReactNode } from 'react';
import { Spinner } from './Spinner.js';
import { BUTTON_DANGER, BUTTON_SECONDARY } from './ui.js';

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** Shown inside the dialog when the confirmed action failed. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A modal confirmation for a destructive action. Focus starts on Cancel, so
 * pressing Enter by reflex does not confirm; Escape and the backdrop cancel.
 */
export function ConfirmDialog({ title, children, confirmLabel, busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // jsdom has no showModal; the dialog is then simply rendered open.
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    else element.setAttribute('open', '');
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onCancel();
      }}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40"
    >
      <div className="p-5">
        <h2 id="confirm-dialog-title" className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <div className="mt-2 text-sm text-muted">{children}</div>
        {error != null && (
          <p role="alert" className="mt-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus className={BUTTON_SECONDARY} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BUTTON_DANGER} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
