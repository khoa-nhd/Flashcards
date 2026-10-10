import type { ReactNode } from 'react';
import { FIELD_ERROR, HELP, LABEL } from './ui.js';

export interface FieldProps {
  /** The id of the control inside; the label, hint and error are tied to it. */
  id: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}

/** The ids a control should reference so its hint and error are announced with it. */
export function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/** A labelled form control with optional help text and an inline validation message. */
export function Field({ id, label, required = false, hint, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
        {required && (
          <span className="ml-1 font-normal text-muted" aria-hidden="true">
            (required)
          </span>
        )}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className={HELP}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className={FIELD_ERROR}>
          {error}
        </p>
      )}
    </div>
  );
}
