import { useEffect, useRef } from 'react';
import { ANSWER_KEY_SETS, type AnswerKeys } from '../hooks/useReviewShortcuts.js';
import { BUTTON_SECONDARY } from './ui.js';

export interface ShortcutHelpProps {
  /** The extra pair of answer keys in use, if any. */
  answerKeys: AnswerKeys;
  /** Whether the last answer can be taken back here. */
  undo: boolean;
  /** Whether a confidence rating is being asked for before each answer. */
  confidence: boolean;
  onClose: () => void;
}

const KEY = 'rounded border border-line bg-paper px-1.5 py-0.5 font-sans text-xs font-semibold';

/** The review shortcuts as they are set up right now. Escape, the backdrop and the button close it. */
export function ShortcutHelp({ answerKeys, undo, confidence, onClose }: ShortcutHelpProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // jsdom has no showModal; the dialog is then simply rendered open.
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    else element.setAttribute('open', '');
    // Lock body scroll as a safety net (native showModal should do this)
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      // Use removeAttribute('open') for non-modal, close() for modal
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  const extra = ANSWER_KEY_SETS[answerKeys];
  const rows: Array<[keys: string[], does: string]> = [
    [['Space'], 'Show the answer, or turn the card back'],
    [['→', ...(extra === null ? [] : [extra[1].toUpperCase()])], 'Remember'],
    [['←', ...(extra === null ? [] : [extra[0].toUpperCase()])], 'Not remember'],
    ...(confidence ? ([[['1', '2', '3'], 'Before the answer: how sure you are (low, medium, high)']] as typeof rows) : []),
    ...(undo ? ([[['U'], 'Undo the last answer']] as typeof rows) : []),
    [['?'], 'Show this list'],
    [['Esc'], 'Close this list or any other panel'],
  ];

  return (
    <dialog
      ref={dialog}
      aria-labelledby="shortcut-help-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40"
    >
      <div className="p-5">
        <h2 id="shortcut-help-title" className="text-lg font-semibold tracking-tight">
          Keyboard shortcuts
        </h2>
        <table className="mt-3 w-full text-sm">
          <caption className="sr-only">Review shortcuts</caption>
          <tbody>
            {rows.map(([keys, does]) => (
              <tr key={does} className="border-t border-line first:border-t-0">
                <th scope="row" className="w-32 py-2 pr-3 text-left align-top font-normal">
                  <span className="flex flex-wrap gap-1">
                    {keys.map((key) => (
                      <kbd key={key} className={KEY}>
                        {key}
                      </kbd>
                    ))}
                  </span>
                </th>
                <td className="py-2">{does}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted">
          An answer needs the card to be showing its answer first. Shortcuts are off while you are typing in a field,
          and work on the Review tab only. Extra answer keys can be chosen in Settings.
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" autoFocus className={BUTTON_SECONDARY} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
