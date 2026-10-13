// @vitest-environment jsdom
/**
 * The front of a review card as an exercise (Method B, owner 2026-10-13):
 * presentation only. What is typed into an exercise stays on the screen — it
 * is never sent with the answer, and the two answer buttons still do all the
 * grading. Every band also falls back to the plain card when what it needs is
 * missing: no example for the cloze, no speech synthesis for listening, the
 * preference switched off.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewActionResponse, ReviewCard } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { SPEECH_RATES } from '../../src/lib/speech.js';
import { createSettingsStore, type Settings } from '../../src/lib/settings.js';
import { createFakeApi, type FakeApiOptions } from '../helpers/fake-api.js';
import { card } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };

interface Options extends FakeApiOptions {
  settings?: Partial<Settings>;
}

/** The local harness pattern from study-experience.test.tsx: the whole app, a fake server, stored preferences. */
async function open(path: string, { settings = {}, ...options }: Options = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ ...options });
  const store = createSettingsStore(null);
  // The app asks for confidence by default; these tests exercise the plain flow unless a test asks for it.
  store.update({ askConfidence: false, ...settings });
  const view = render(<App api={fake.api} settings={store} />);
  await screen.findAllByRole('navigation');
  return { ...fake, store, user: userEvent.setup(), ...view };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key, ...init });
const isFlipped = () => screen.getByTestId('flashcard').dataset.flipped === 'true';
const exercise = () => screen.getByTestId('review-exercise');
const typedLine = () => screen.getByText(/^You typed/);

/** A card in the cloze band, with an example that contains its word whole. */
function clozeCard(n: number, overrides: Partial<ReviewCard> = {}): ReviewCard {
  return card(n, {
    mastery: 4,
    back: [
      { key: 'definition', label: 'Definition', value: `definition of word-${n}` },
      { key: 'example', label: 'Example', value: `Try word-${n} in a sentence.` },
    ],
    ...overrides,
  });
}

/** A card in the listening band: at this mastery the server withholds the example entirely. */
const listeningCard = (n: number) => card(n, { mastery: 7, back: [], detailsHidden: true });

describe('the cloze front', () => {
  it('shows the example with the word blanked out, not the word itself', async () => {
    await open('/review', { cards: [clozeCard(1)] });
    await screen.findByTestId('flashcard');

    expect(exercise()).toHaveAttribute('data-kind', 'cloze');
    expect(exercise()).toHaveTextContent('Try in a sentence.');
    expect(exercise()).not.toHaveTextContent('word-1');
    expect(screen.queryByRole('heading', { name: 'word-1' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('The word missing from the sentence')).toBeInTheDocument();
  });

  it('keeps every typed letter away from the review: no flip, no answer, until the card is flipped', async () => {
    const { api, user, saves } = await open('/review', { cards: [clozeCard(1), clozeCard(2)] });
    await screen.findByTestId('flashcard');

    await user.type(screen.getByLabelText('The word missing from the sentence'), 'not the word');
    // Typing a space must not reach the flip shortcut, and none of it is sent anywhere.
    expect(isFlipped()).toBe(false);
    expect(api.submitAction).not.toHaveBeenCalled();

    press(' ');
    expect(isFlipped()).toBe(true);
    expect(typedLine()).toHaveTextContent('You typed “not the word”: Not quite. Spelled: word-1.');

    press('ArrowRight');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction.mock.calls[0]?.[0]).toMatchObject({ pageId: clozeCard(1).id, action: 'remember' });
    expect(JSON.stringify(api.submitAction.mock.calls[0]?.[0])).not.toContain('not the word');

    // The exercise never stood in for the answer: the save settles and the session moves on as usual.
    await act(async () => saves[0]?.resolve(applied));
    expect(isFlipped()).toBe(false);
  });

  it('says Correct and shows the expected spelling when the word is typed right', async () => {
    const { user } = await open('/review', { cards: [clozeCard(1)] });
    await screen.findByTestId('flashcard');

    await user.type(screen.getByLabelText('The word missing from the sentence'), 'Word-1');
    press(' ');
    expect(typedLine()).toHaveTextContent('You typed “Word-1”: Correct. Spelled: word-1.');
  });

  it('shows the plain card when the word has no usable example', async () => {
    await open('/review', { cards: [clozeCard(1, { back: [{ key: 'example', label: 'Example', value: 'No word here.' }] })] });
    await screen.findByTestId('flashcard');

    expect(screen.queryByTestId('review-exercise')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'word-1' })).toBeInTheDocument();
  });

  it('is the plain card when the Challenge cards preference is off', async () => {
    await open('/review', { cards: [clozeCard(1)], settings: { reviewExercises: false } });
    await screen.findByTestId('flashcard');

    expect(screen.queryByTestId('review-exercise')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'word-1' })).toBeInTheDocument();
  });

  it('starts empty again for the next card, so one attempt never leaks onto another', async () => {
    const { user, saves } = await open('/review', { cards: [clozeCard(1), clozeCard(2)] });
    await screen.findByTestId('flashcard');

    const first = screen.getByLabelText('The word missing from the sentence');
    await user.type(first, 'nope');
    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve(applied));

    const second = await screen.findByLabelText('The word missing from the sentence');
    expect(second).toHaveValue('');
  });
});

describe('the listening front', () => {
  /** jsdom has no speech synthesis, so the browser's side is stood in for here. */
  let spoken: string[] = [];
  /** The speed each reading was started at, so "Play slowly" can be told apart from a normal play. */
  let speeds: number[] = [];

  function stubSpeech() {
    const words: string[] = [];
    const rates: number[] = [];
    speeds = rates;
    class Utterance {
      text: string;
      lang = '';
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const synth = {
      cancel: () => {},
      getVoices: () => [],
      // Ends at once: the tests care that the word was said, not how long speech takes.
      speak: (utterance: InstanceType<typeof Utterance>) => {
        words.push(utterance.text);
        rates.push(utterance.rate);
        utterance.onend?.();
      },
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
    return words;
  }

  function unstubSpeech() {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  }

  beforeEach(() => {
    spoken = stubSpeech();
  });
  afterEach(() => {
    unstubSpeech();
  });

  it('plays the word once when the card appears and offers a replay, with an input to type into', async () => {
    const { user } = await open('/review', { cards: [listeningCard(1)] });
    await screen.findByTestId('flashcard');

    expect(exercise()).toHaveAttribute('data-kind', 'listening');
    expect(spoken).toEqual(['word-1']);
    await user.click(screen.getByRole('button', { name: 'Play / Play again' }));
    expect(spoken).toEqual(['word-1', 'word-1']);

    // The word is never shown on the front: hearing it is the question.
    expect(screen.queryByRole('heading', { name: 'word-1' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('The word you hear'), 'ephemeral');
    expect(isFlipped()).toBe(false);
    press(' ');
    expect(typedLine()).toHaveTextContent('You typed “ephemeral”: Not quite. Spelled: word-1.');
  });

  it('reads it slowly on request, at the slower speed', async () => {
    const { user } = await open('/review', { cards: [listeningCard(1)] });
    await screen.findByTestId('flashcard');

    await user.click(screen.getByRole('button', { name: 'Play slowly' }));
    expect(speeds.at(-1)).toBe(SPEECH_RATES.slow);
  });

  it('is the plain card when the browser cannot read aloud at all', async () => {
    unstubSpeech();
    await open('/review', { cards: [listeningCard(1)] });
    await screen.findByTestId('flashcard');

    expect(screen.queryByTestId('review-exercise')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'word-1' })).toBeInTheDocument();
  });
});
