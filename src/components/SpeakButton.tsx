/**
 * Reads a word aloud with the browser's own voice, in the accent the caller
 * passes — the same setting practice listening uses. It is hidden where the
 * browser has no speech at all, and says so on the spot when a reading fails —
 * never silence without explanation. Nothing is sent anywhere.
 */
import { useState } from 'react';
import { speak, speechAvailable } from '../lib/speech.js';
import { Icon } from './Icon.js';

export function SpeakButton({ word, lang }: { word: string; lang: string }) {
  const [failed, setFailed] = useState(false);

  if (!speechAvailable()) return null;

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Read ${word} aloud`}
        title="Hear this word"
        className="cursor-pointer rounded-lg border border-line bg-surface p-2 text-muted hover:border-muted hover:text-ink"
        // The card around this button flips on click; reading the word must not.
        onClick={(event) => {
          event.stopPropagation();
          setFailed(false);
          void speak(word, { lang }).catch(() => setFailed(true));
        }}
      >
        <Icon name="speaker" className="size-4" />
      </button>
      {failed && (
        <span role="alert" className="text-xs text-bad-ink">
          This browser could not read it aloud.
        </span>
      )}
    </span>
  );
}