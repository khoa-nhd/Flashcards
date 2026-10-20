// @vitest-environment jsdom
/**
 * Discovery & Input as the learner meets it: a phrase captured from
 * anywhere on the keyboard, a word selected while reading and saved with
 * its sentence, a selection marked for later with no word at all, a
 * workspace that comes back where it was left, a transcript listened to by
 * its own times, a draft that keeps nothing until it is accepted, and
 * content brought in by paste, file or address. Every path ends in the
 * same rule: a word exists only because the learner pressed Save, and
 * nothing here touches review, practice or mastery.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import type { AppApi } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

/** Renders the app over one fake, optionally at a path built from its own api. */
async function start(options: FakeApiOptions = {}, at?: (api: AppApi) => Promise<string>) {
  const fake = createFakeApi(options);
  const path = at === undefined ? '/discover' : await at(fake.api);
  window.history.replaceState(null, '', path);
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

/** Selects a range of a rendered text and releases the mouse, the way a reader does. */
function selectWithin(element: HTMLElement, from: number, to: number) {
  const node = element.firstChild;
  if (node === null || node.nodeType !== Node.TEXT_NODE) throw new Error('expected the text itself, not a wrapper');
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection();
  if (selection === null) throw new Error('this browser has no selection');
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(element);
}

const READING = 'She was candid about the plan. Everyone nodded along.';

const openReading = (options: FakeApiOptions = {}) =>
  start(options, async (api) => {
    const created = await api.createSource({
      kind: 'text',
      title: 'A note',
      content: READING,
      origin: 'typed',
      requestId: 'req-text-1',
    });
    return `/discover?view=read&source=${created.id}`;
  });

describe('quick capture, from anywhere', () => {
  it('opens with Alt+K and saves a typed phrase as a word on the one press', async () => {
    const app = await start();
    await app.user.keyboard('{Alt>}k{/Alt}');
    const dialog = screen.getByRole('dialog', { name: 'Quick capture' });
    // An empty field cannot be saved.
    expect(within(dialog).getByRole('button', { name: 'Save now' })).toBeDisabled();
    await app.user.type(within(dialog).getByLabelText(/word, phrase, collocation/i), 'call it a day');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save now' }));
    await within(dialog).findByText(/Saved “call it a day” to your vocabulary/);
    expect(app.store.map((item) => item.word)).toEqual(['call it a day']);
  });

  it('offers the existing word when the phrase is already saved, and keeps both only on purpose', async () => {
    const app = await start({ entries: [entry(1, { word: 'candid', meaning: 'thẳng thắn' })] });
    await app.user.click(screen.getAllByRole('button', { name: 'Quick capture' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Quick capture' });
    await app.user.type(within(dialog).getByLabelText(/word, phrase, collocation/i), 'candid');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save now' }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByText(/is already in your vocabulary/)).toBeTruthy();
    // The refusal itself created nothing.
    expect(app.store).toHaveLength(1);
    await app.user.click(within(dialog).getByRole('button', { name: 'Keep both words' }));
    await within(dialog).findByText(/Saved “candid” to your vocabulary/);
    expect(app.store.filter((item) => item.word === 'candid')).toHaveLength(2);
  });

  it('keeps a phrase for later with no word at all', async () => {
    const app = await start();
    await app.user.click(screen.getAllByRole('button', { name: 'Quick capture' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Quick capture' });
    await app.user.type(within(dialog).getByLabelText(/word, phrase, collocation/i), 'call it a day');
    await app.user.click(within(dialog).getByRole('button', { name: 'Mark for later' }));
    await within(dialog).findByText(/Marked for later — nothing was saved/);
    expect(app.store).toHaveLength(0);
    await app.user.click(within(dialog).getByRole('button', { name: 'Done' }));
    // Waiting under Discovery, still with no word.
    fireEvent.click(screen.getAllByRole('link', { name: 'Discovery' })[0]!);
    await screen.findByText('call it a day');
    expect(app.store).toHaveLength(0);
  });
});

describe('reading a source, and the word that leaves it', () => {
  it('explains the selection from its sentence alone, saves it, and offers the way back', async () => {
    const app = await openReading();
    selectWithin(await screen.findByTestId('reader-body'), 8, 14); // "candid"
    const panel = screen.getByRole('region', { name: 'Selection: candid' });
    await app.user.click(within(panel).getByRole('button', { name: 'Explain this word' }));
    const meaning = await within(panel).findByLabelText('Vietnamese meaning');
    expect((meaning as HTMLInputElement).value).toBe('nghĩa của candid');
    await app.user.click(within(panel).getByRole('button', { name: 'Save to vocabulary' }));
    await within(panel).findByText(/Saved “candid” to your vocabulary/);
    // The sentence came along with the word.
    const saved = app.store.find((item) => item.word === 'candid');
    expect(saved?.example).toContain('candid');
    // Journey H: over to the Word Profile, and back to the source.
    await app.user.click(within(panel).getByRole('button', { name: 'View in Word Profile' }));
    const wordPanel = await screen.findByRole('dialog', { name: 'candid' });
    await within(wordPanel).findByText(/Found in/);
    await app.user.click(within(wordPanel).getByRole('link', { name: 'A note' }));
    await screen.findByTestId('reader-body');
    expect(screen.queryByRole('dialog', { name: 'candid' })).toBeNull();
  });

  it('remembers where the reader was, and says so on the way back', async () => {
    const app = await openReading();
    selectWithin(await screen.findByTestId('reader-body'), 8, 14);
    await app.user.click(screen.getByRole('button', { name: 'Mark for later' }));
    expect(app.api.updateSource).toHaveBeenCalledWith(expect.any(String), {
      position: { offset: expect.any(Number) },
    });
    app.unmount();
    render(<App api={app.api} settings={createSettingsStore(null)} />);
    await screen.findAllByRole('navigation');
    await screen.findByText('Picked up where you left off.');
  });

  it('marks a selection without saving it, and dismissing the mark leaves nothing behind', async () => {
    const app = await openReading();
    selectWithin(await screen.findByTestId('reader-body'), 8, 14);
    const panel = screen.getByRole('region', { name: 'Selection: candid' });
    await app.user.click(within(panel).getByRole('button', { name: 'Mark for later' }));
    await within(panel).findByText(/Marked for later — nothing was saved yet/);
    expect(app.store).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('link', { name: 'Discovery' })[0]!);
    const marks = await screen.findByRole('region', { name: 'Marked for later' });
    expect(within(marks).getByText('candid')).toBeTruthy();
    await app.user.click(within(marks).getByRole('button', { name: 'Dismiss' }));
    await within(marks).findByText(/Nothing is waiting/);
    expect(app.store).toHaveLength(0);
  });

  it('saves a marked selection with its sentence when the learner finally presses save', async () => {
    const app = await openReading();
    selectWithin(await screen.findByTestId('reader-body'), 8, 14);
    await app.user.click(screen.getByRole('button', { name: 'Mark for later' }));
    fireEvent.click(screen.getAllByRole('link', { name: 'Discovery' })[0]!);
    const marks = await screen.findByRole('region', { name: 'Marked for later' });
    await app.user.click(within(marks).getByRole('button', { name: 'Save…' }));
    await app.user.type(within(marks).getByLabelText('Vietnamese meaning'), 'thẳng thắn');
    await app.user.click(within(marks).getByRole('button', { name: 'Save this word' }));
    await within(marks).findByText(/Saved “candid”\./);
    const saved = app.store.find((item) => item.word === 'candid');
    expect(saved?.meaning).toBe('thẳng thắn');
    expect(saved?.example).toContain('candid');
  });
});

describe('listening to a transcript', () => {
  const SRT =
    '1\n00:00:01,000 --> 00:00:03,400\nHello world\n\n2\n00:00:05,000 --> 00:00:08,200\nThe weather is fine today\n';

  const openTranscript = (content: string, contentKind: 'transcript' | 'plain') =>
    start({}, async (api) => {
      const created = await api.createSource({
        kind: 'listening',
        title: 'Episode 12',
        content,
        contentKind,
        origin: 'episode12.srt',
        requestId: 'req-srt-1',
      });
      return `/discover?view=listen&source=${created.id}`;
    });

  it('seeks by a cue’s own time and captures a word with that cue behind it', async () => {
    const app = await openTranscript(SRT, 'transcript');
    await app.user.click(await screen.findByRole('button', { name: 'Seek to 0:01' }));
    expect(app.api.updateSource).toHaveBeenCalledWith(expect.any(String), { position: { seconds: 1 } });
    const line = await screen.findByText('The weather is fine today');
    selectWithin(line, 4, 12); // "weather"
    const panel = screen.getByRole('region', { name: 'Selection: weather' });
    // The cue, not the transcript, is what the panel carries.
    expect(within(panel).getByText('The weather is fine today')).toBeTruthy();
    await app.user.click(within(panel).getByRole('button', { name: 'Save to vocabulary' }));
    await within(panel).findByText(/Saved “weather” to your vocabulary/);
    const saved = app.store.find((item) => item.word === 'weather');
    expect(saved?.example).toBe('The weather is fine today');
  });

  it('reads a transcript without timestamps as plain text, and says why it cannot seek', async () => {
    const app = await openTranscript('Some quiet words to listen along with.', 'plain');
    expect(await screen.findByTestId('listener-body')).toBeTruthy();
    expect(screen.getByText(/This transcript has no timestamps/)).toBeTruthy();
    // With no address, the player stays off — and the transcript still works.
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByText(/the transcript below still works/)).toBeTruthy();
    // Opening a source of any kind saves no word by itself.
    expect(app.store).toHaveLength(0);
  });
});

describe('a reading drafted from a collection', () => {
  it('previews the draft, keeps everything untouched, and creates only on acceptance', async () => {
    const app = await start({
      entries: [entry(1, { word: 'candid', meaning: 'thẳng thắn' })],
      library: { collections: [{ id: 'col-1', name: 'Work words', wordIds: ['p1'] }] },
    });
    await app.user.click(screen.getByRole('link', { name: 'Generate' }));
    await app.user.click(screen.getByLabelText('A saved collection'));
    await app.user.selectOptions(screen.getByLabelText('Collection'), 'col-1');
    await app.user.click(screen.getByRole('button', { name: 'Write a draft' }));
    await screen.findByRole('heading', { name: 'Draft — check it before keeping it' });
    expect(app.api.generateDraft).toHaveBeenCalledWith(expect.objectContaining({ collectionId: 'col-1' }));
    // Nothing exists until the learner accepts it.
    expect(await app.api.listSources()).toHaveLength(0);
    expect(app.store).toHaveLength(1);
    await app.user.click(screen.getByRole('button', { name: 'Use this reading' }));
    await screen.findByTestId('reader-body');
    expect(window.location.search).toContain('view=read');
    // Accepted: one generated source with its candidate waiting as a mark —
    // and still no word saved by the acceptance.
    const sources = await app.api.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe('generated');
    expect(sources[0]?.markedCount).toBe(1);
    expect(app.store).toHaveLength(1);
  });
});

describe('bringing content in', () => {
  it('previews pasted text and opens it in the reading workspace, storing only that text', async () => {
    const app = await start();
    await app.user.click(screen.getByRole('link', { name: 'Import' }));
    await app.user.click(screen.getByRole('button', { name: 'Paste text' }));
    await app.user.type(screen.getByLabelText('Title (optional)'), 'A pasted note');
    await app.user.type(screen.getByLabelText('The text'), 'Some words worth keeping for later.');
    await app.user.click(screen.getByRole('button', { name: 'Preview it' }));
    await screen.findByText('Preview — nothing is saved yet');
    expect(app.store).toHaveLength(0);
    expect(await app.api.listSources()).toHaveLength(0);
    await app.user.click(screen.getByRole('button', { name: 'Open in the reading workspace' }));
    await screen.findByTestId('reader-body');
    expect(screen.getByText('Some words worth keeping for later.')).toBeTruthy();
    const sources = await app.api.listSources();
    expect(sources[0]?.kind).toBe('imported');
  });

  it('refuses a file this app will not read, and says what to do instead', async () => {
    const app = await start();
    await app.user.click(screen.getByRole('link', { name: 'Import' }));
    const file = new File(['%PDF-1.7 …'], 'chapter.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose a text file'), { target: { files: [file] } });
    await screen.findByText(/is not a text file this app can read/);
    expect(await app.api.listSources()).toHaveLength(0);
  });

  it('fetches a web address into a preview that stores nothing until it is opened', async () => {
    const app = await start();
    await app.user.click(screen.getByRole('link', { name: 'Import' }));
    app.api.fetchUrl.mockResolvedValueOnce({
      title: 'An article',
      text: 'Words worth reading, brought back as plain text.',
      origin: 'https://example.com/article',
    });
    await app.user.click(screen.getByRole('button', { name: 'From a web address' }));
    await app.user.type(screen.getByLabelText('Web address'), 'https://example.com/article');
    await app.user.click(screen.getByRole('button', { name: 'Fetch a preview' }));
    await screen.findByText('An article');
    expect(app.api.fetchUrl).toHaveBeenCalledWith('https://example.com/article');
    // A preview stores nothing.
    expect(await app.api.listSources()).toHaveLength(0);
    await app.user.click(screen.getByRole('button', { name: 'Open in the reading workspace' }));
    await screen.findByTestId('reader-body');
    const sources = await app.api.listSources();
    expect(sources[0]?.kind).toBe('web');
    expect(sources[0]?.origin).toBe('https://example.com/article');
  });
});
