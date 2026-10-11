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
