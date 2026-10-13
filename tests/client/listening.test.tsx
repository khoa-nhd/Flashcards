// @vitest-environment jsdom
/**
 * Listening practice. The browser reads the word aloud; here a stand-in
 * records what it was asked to say, so these tests check what the app asks
 * for and what it shows. They cannot check what anything sounds like.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { speak, speechAvailable, stopSpeaking } from '../../src/lib/speech.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';

const WORDS: VocabularyEntry[] = [
  entry(1, { word: 'candid', meaning: 'thẳng thắn', definition: 'Honest and direct.' }),
  // No meaning, definition or example: the other modes cannot use it, listening can.
  entry(2, { word: 'lucid', meaning: null, definition: null, example: null }),
];

interface Said {
  text: string;
  lang: string;
  rate: number;
  voice: string | null;
}

/** What the page asked the browser to say, and a way to finish or fail each one. */
function installSpeech(voices: Array<{ lang: string; name: string }> = [{ lang: 'en-US', name: 'Test US' }]) {
  const said: Said[] = [];
  const pending: Array<{ end(): void; fail(error: string): void }> = [];
  let cancelled = 0;

  class Utterance {
    lang = '';
    rate = 1;
    voice: { lang: string; name: string } | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    constructor(public text: string) {}
  }

  Object.assign(window, {
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: {
      getVoices: () => voices,
      cancel: () => {
        cancelled += 1;
      },
      speak(utterance: Utterance) {
        said.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate, voice: utterance.voice?.name ?? null });
        pending.push({
          end: () => utterance.onend?.(),
          fail: (error) => utterance.onerror?.({ error }),
        });
      },
    },
  });
  return { said, pending, cancelled: () => cancelled };
}

function removeSpeech() {
  const target = window as unknown as Record<string, unknown>;
  delete target.speechSynthesis;
  delete target.SpeechSynthesisUtterance;
}

async function open(path = '/practice?mode=listening&source=all') {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: WORDS });
  const settings = createSettingsStore(null);
  render(<App api={fake.api} settings={settings} />);
  await screen.findAllByRole('navigation');
  return { ...fake, settings, user: userEvent.setup() };
}

const main = () => within(screen.getByRole('main'));

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  removeSpeech();
});

describe('where the browser can read text aloud', () => {
  it('offers Listening like any other way to practise, and says where the voice comes from', async () => {
    installSpeech();
    await open();
    const option = (await main().findByRole('radio', { name: /Listening/ })).closest('label')!;
    expect(option).not.toHaveTextContent('Experimental');
    expect(option).toHaveTextContent('Hear the word read aloud by your browser, type what you hear.');
    expect(main().getByText(/read by this browser’s own voice/)).toHaveTextContent('Nothing is sent anywhere');
    // Listening asks only for the word, so even an entry with nothing else can be used.
    expect(main().getByRole('status')).toHaveTextContent('2 of 2 words can be used for listening.');
  });

  it('plays the word when the question appears, without ever putting it on the page', async () => {
    const speech = installSpeech();
    const { user } = await open();
    await user.click(await main().findByRole('button', { name: 'Start' }));

    await waitFor(() => expect(speech.said).toHaveLength(1));
    const asked = speech.said[0]!;
    expect(['candid', 'lucid']).toContain(asked.text);
    expect(asked).toMatchObject({ lang: 'en-US', rate: 1, voice: 'Test US' });

    // Nothing visible or named gives the answer away: not the text, not a button's label.
    expect(screen.getByRole('main')).not.toHaveTextContent(asked.text);
    for (const button of main().getAllByRole('button')) {
      expect(button.getAttribute('aria-label') ?? button.textContent).not.toContain(asked.text);
    }
    expect(main().getByRole('button', { name: 'Play the word' })).toBeInTheDocument();
  });

  it('plays it again on request, and slowly on request', async () => {
    const speech = installSpeech();
    const { user } = await open();
    await user.click(await main().findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(speech.said).toHaveLength(1));

    await user.click(main().getByRole('button', { name: 'Play the word' }));
    await user.click(main().getByRole('button', { name: 'Play it slowly' }));
    expect(speech.said.map((item) => item.rate)).toEqual([1, 1, 0.6]);
    expect(new Set(speech.said.map((item) => item.text)).size).toBe(1);
  });

  it('judges what was typed like any typed answer, and records it as listening', async () => {
    const speech = installSpeech();
    const { user, api } = await open();
    await user.click(await main().findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(speech.said).toHaveLength(1));
    const heard = speech.said[0]!.text;
    const word = WORDS.find((item) => item.word === heard)!;

    await user.type(main().getByLabelText('Your answer'), `${heard.toUpperCase()}{Enter}`);
    await waitFor(() => expect(api.submitPractice).toHaveBeenCalledTimes(1));
    expect(api.submitPractice.mock.calls[0]![0]).toMatchObject({
      pageId: word.id,
      mode: 'listening',
      answer: { kind: 'typed', text: heard.toUpperCase() },
    });
    // Capitals are not spelling: the same rules as Typing.
    expect(await main().findByRole('status')).toHaveTextContent('Correct.');
    // Practice only: nothing that could move a schedule was sent.
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('shows the word after a miss', async () => {
    const speech = installSpeech();
    const { user } = await open();
    await user.click(await main().findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(speech.said).toHaveLength(1));
    const heard = speech.said[0]!.text;

    await user.type(main().getByLabelText('Your answer'), 'something else{Enter}');
    const verdict = await main().findByText('Not quite.');
    expect(verdict.closest('[role="status"]')).toHaveTextContent(`The answer is ${heard}`);
  });

  it('says so when the word could not be played, instead of leaving silence unexplained', async () => {
    const speech = installSpeech();
    const { user } = await open();
    await user.click(await main().findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(speech.pending).toHaveLength(1));

    speech.pending[0]!.fail('synthesis-failed');
    expect(await main().findByRole('alert')).toHaveTextContent('The word could not be played');

    // Trying again clears the message while it plays.
    await user.click(main().getByRole('button', { name: 'Play the word' }));
    expect(main().queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads in the accent that was chosen, and remembers the choice', async () => {
    const speech = installSpeech([
      { lang: 'en-US', name: 'Test US' },
      { lang: 'en-GB', name: 'Test UK' },
    ]);
    const { user, settings } = await open();
    await user.selectOptions(await main().findByLabelText('Accent'), 'en-GB');
    expect(settings.getState().speechLang).toBe('en-GB');

    await user.click(main().getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(speech.said).toHaveLength(1));
    expect(speech.said[0]).toMatchObject({ lang: 'en-GB', voice: 'Test UK' });
  });

  it('stops speaking when the question is left', async () => {
    const speech = installSpeech();
    const { user } = await open();
    await user.click(await main().findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(speech.said).toHaveLength(1));
    const before = speech.cancelled();
    await user.click(screen.getByRole('button', { name: 'End practice' }));
    expect(speech.cancelled()).toBeGreaterThan(before);
  });
});

describe('where the browser cannot read text aloud', () => {
  it('says Listening is not available here and will not start it', async () => {
    removeSpeech();
    const { user } = await open();
    expect(await main().findByRole('alert')).toHaveTextContent('This browser cannot read text aloud');
    expect(main().getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(main().queryByLabelText('Accent')).not.toBeInTheDocument();

    // The other modes are untouched by it.
    await user.click(main().getByRole('radio', { name: /Typing/ }));
    expect(main().queryByRole('alert')).not.toBeInTheDocument();
    expect(main().getByRole('button', { name: 'Start' })).toBeEnabled();
  });
});

describe('the speech helper', () => {
  it('reports that there is no speech rather than throwing', async () => {
    removeSpeech();
    expect(speechAvailable()).toBe(false);
    expect(() => stopSpeaking()).not.toThrow();
    await expect(speak('candid', { lang: 'en-US' })).rejects.toThrow('cannot read text aloud');
  });

  it('takes a voice of the same language when the exact accent is missing, and none when there is no match', async () => {
    const speech = installSpeech([{ lang: 'en-GB', name: 'Test UK' }]);
    void speak('candid', { lang: 'en-AU' });
    void speak('candid', { lang: 'fr-FR' });
    expect(speech.said.map((item) => item.voice)).toEqual(['Test UK', null]);
  });

  it('treats being cut short as finished, and a real failure as a failure', async () => {
    const speech = installSpeech();
    const interrupted = speak('candid', { lang: 'en-US' });
    speech.pending[0]!.fail('interrupted');
    await expect(interrupted).resolves.toBeUndefined();

    const broken = speak('candid', { lang: 'en-US' });
    speech.pending[1]!.fail('audio-busy');
    await expect(broken).rejects.toThrow('audio-busy');
  });
});
