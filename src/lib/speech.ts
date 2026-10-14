/**
 * Reading a word aloud with the browser's own speech synthesis. The app sends
 * nothing anywhere for this and has no audio of its own: which voices exist,
 * how good they are, and whether one needs a connection is up to the device
 * and browser. Where there is no speech synthesis at all, everything here
 * says so instead of failing.
 */

/** The accents offered. The browser picks the nearest voice it has; it may have none for some of these. */
export const SPEECH_LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AU', 'English (Australia)'],
  ['en-IN', 'English (India)'],
] as const;

export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number][0];

export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguage = 'en-US';

/** The normal speed, and a slower one for a second listen. */
export const SPEECH_RATES = { normal: 1, slow: 0.6 } as const;

/**
 * Just enough of the recognition API to use it. The browser's own typings do
 * not cover the prefixed name every engine ships, and more of the interface
 * would only invite using more of it.
 */
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  }
}

export function speechAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

/** Stops whatever is being said. Safe to call where there is no speech at all. */
export function stopSpeaking(): void {
  if (speechAvailable()) window.speechSynthesis.cancel();
}

// ---------------------------------------------------------------------------
// The other direction: what the browser hears
// ---------------------------------------------------------------------------

/**
 * The browser's own speech recognition, which is a different API from speech
 * synthesis and does not exist everywhere. It may ask for the microphone the
 * first time, and where it is refused nothing here can help — the mode says
 * so and stays off, exactly as listening does where nothing can be read aloud.
 */
export function recognitionAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  return typeof Constructor !== 'undefined';
}

/** Why a listen produced no transcript. Each one is shown to the speaker as it is. */
export type ListenFailure = 'not_allowed' | 'no_speech' | 'unavailable';

/**
 * Listens once, for as long as the browser keeps hearing speech, and resolves
 * with the first final transcript it writes down. Nothing is sent anywhere by
 * this app: the device's own recognition does what it does, and its quality —
 * including whether it needs a connection — is the browser's business.
 */
export function listenOnce(lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (Constructor === undefined) {
      reject(new Error('unavailable' satisfies ListenFailure));
      return;
    }
    const recognizer = new Constructor();
    recognizer.lang = lang;
    // One final result is enough; interim results would flicker under the field.
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      try {
        recognizer.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      work();
    };
    recognizer.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? '';
      finish(() => resolve(transcript));
    };
    recognizer.onerror = (event) => {
      const failure: ListenFailure =
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'not_allowed'
          : event.error === 'no-speech'
            ? 'no_speech'
            : 'unavailable';
      finish(() => reject(new Error(failure)));
    };
    // Some browsers end the session on their own after a silence; an empty
    // listen is a no-speech, not a hang.
    recognizer.onend = () => finish(() => reject(new Error('no_speech' satisfies ListenFailure)));
    recognizer.start();
  });
}

/**
 * Says `text` once. Resolves when it has been said, or when it was cut short
 * by `stopSpeaking` or by the next call; rejects when the browser could not
 * say it, so the caller can tell the listener rather than leave silence
 * unexplained.
 */
export function speak(text: string, options: { lang: string; rate?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!speechAvailable()) {
      reject(new Error('This browser cannot read text aloud.'));
      return;
    }
    const synth = window.speechSynthesis;
    // One thing at a time: a second press replaces the first rather than queueing behind it.
    synth.cancel();
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = options.lang;
    utterance.rate = options.rate ?? SPEECH_RATES.normal;
    // The browser's default voice may belong to another language altogether, so prefer one that matches.
    const voices = synth.getVoices();
    const voice =
      voices.find((candidate) => candidate.lang === options.lang) ??
      voices.find((candidate) => candidate.lang.slice(0, 2) === options.lang.slice(0, 2));
    if (voice !== undefined) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') resolve();
      else reject(new Error(event.error));
    };
    synth.speak(utterance);
  });
}
