// @vitest-environment jsdom
/**
 * The speaker on every card that shows a word: it reads the word with the
 * browser's own voice in the accent practice uses, does not flip or answer
 * anything around it, and is not shown at all where the browser cannot read
 * aloud — the same rule the listening mode follows.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';
import { card } from '../helpers/fixtures.js';

/** jsdom has no speech synthesis, so the browser's side is stood in for here. */
let spoken: string[] = [];

function stubSpeech() {
  const words: string[] = [];
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
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: () => {},
      getVoices: () => [],
      // Ends at once: the test cares that the word was said, not how long speech takes.
      speak: (utterance: InstanceType<typeof Utterance>) => {
        words.push(utterance.text);
        utterance.onend?.();
      },
    },
  });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
  spoken = words;
}

function unstubSpeech() {
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
}

async function open(path: string) {
  window.history.replaceState(null, '', path);
  // Recognition draws four choices, so a recognisable pool needs four words.
  const fake = createFakeApi({ entries: [entry(1), entry(2), entry(3), entry(4)], cards: [card(1)] });
  const view = render(<App api={fake.api} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => unstubSpeech());
afterEach(() => unstubSpeech());

describe('the speaker on a card', () => {
  it('reads the word on the front of a review card without flipping it', async () => {
    stubSpeech();
    const { user } = await open('/review');
    const flashcard = await screen.findByTestId('flashcard');

    await user.click(screen.getByRole('button', { name: 'Read word-1 aloud' }));

    expect(spoken).toEqual(['word-1']);
    expect(flashcard.dataset.flipped).toBe('false');
  });

  it('reads the word on a practice question', async () => {
    stubSpeech();
    const { user } = await open('/practice?mode=recognition&source=all');

    // The eligibility line only appears once the vocabulary is loaded.
    await screen.findByText(/can be used/);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    const speaker = await screen.findByRole('button', { name: /Read word-\d aloud/ });
    const word = speaker.getAttribute('aria-label')!.replace('Read ', '').replace(' aloud', '');
    await user.click(speaker);

    expect(spoken).toEqual([word]);
  });

  it('is not shown where the browser cannot read aloud at all', async () => {
    await open('/review');
    await screen.findByTestId('flashcard');

    expect(screen.queryByRole('button', { name: 'Read word-1 aloud' })).not.toBeInTheDocument();
  });
});
