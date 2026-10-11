import { useCallback, useEffect, useRef, useState } from 'react';
import { SPEECH_RATES, speak, stopSpeaking } from '../lib/speech.js';
import { BUTTON_SECONDARY, HELP } from './ui.js';

export interface ListenPromptProps {
  /** What is read aloud. It is never shown or named here: hearing it is the question. */
  text: string;
  lang: string;
  /** Once answered there is nothing left to give away, and replaying helps the answer sink in. */
  answered: boolean;
}

/**
 * The question in Listening practice: the word, read aloud by the browser. It
 * plays once when it appears and again on request, at normal speed or slowly.
 * If the browser cannot play it, it says so.
 */
export function ListenPrompt({ text, lang, answered }: ListenPromptProps) {
  // It starts by playing, so that is the state it starts in.
  const [playing, setPlaying] = useState(true);
  const [failed, setFailed] = useState(false);
  /** Counts readings, so the end of an earlier one cannot mark a later one as finished. */
  const turn = useRef(0);

  /** Starts one reading. Nothing on screen changes until it ends, one way or the other. */
  const begin = useCallback(
    (rate: number) => {
      const mine = ++turn.current;
      speak(text, { lang, rate }).then(
        () => {
          if (turn.current === mine) setPlaying(false);
        },
        () => {
          if (turn.current !== mine) return;
          setPlaying(false);
          setFailed(true);
        },
      );
    },
    [text, lang],
  );

  const play = (rate: number) => {
    setPlaying(true);
    setFailed(false);
    begin(rate);
  };

  useEffect(() => {
    begin(SPEECH_RATES.normal);
    return () => {
      // Leaving the question silences it, and whatever was playing no longer reports back.
      turn.current += 1;
      stopSpeaking();
    };
  }, [begin]);

  return (
    <div className="rounded-3xl border border-line bg-surface px-6 py-8 text-center shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Listen</p>
      <p className="mt-2 text-sm text-muted" aria-live="polite">
        {playing ? 'Playing…' : answered ? 'Play it again to hear it once more.' : 'Type the word you hear.'}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" className={BUTTON_SECONDARY} onClick={() => play(SPEECH_RATES.normal)}>
          Play the word
        </button>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => play(SPEECH_RATES.slow)}>
          Play it slowly
        </button>
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-bad-ink">
          The word could not be played. Check that sound is on, then try again. If it never plays, this browser may
          have no voice for the accent chosen.
        </p>
      )}
      <p className={`${HELP} mt-3`}>Read aloud by this browser’s own voice, so how it sounds depends on the device.</p>
    </div>
  );
}
