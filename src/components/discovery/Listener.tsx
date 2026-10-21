import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DISCOVERY_LIMITS, type DiscoverySourceDocument } from '../../../shared/discovery.js';
import { useApp } from '../../app-context.js';
import { offsetWithin } from '../../lib/text-selection.js';
import { clockTime, parseTranscript, type TranscriptCue } from '../../lib/transcript.js';
import { Icon } from '../Icon.js';
import { Link } from '../Link.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_SECONDARY, CARD, HELP, INPUT, LABEL } from '../ui.js';
import { discoverHref, KIND_LABELS } from './labels.js';
import { failureMessage } from './message.js';
import { SelectionPanel } from './SelectionPanel.js';

/** A selection made in the transcript: either a cue's window or a plain offset. */
type TranscriptSelection =
  | { kind: 'cue'; label: string; cue: TranscriptCue }
  | { kind: 'plain'; label: string; offset: number };

export interface ListenerProps {
  sourceId: string | null;
  onPickAnother(): void;
}

/**
 * The listening workspace: a transcript with its cues, an audio address the
 * learner gives it (kept in this tab, never saved), and selections that
 * carry their timestamp. Play, pause and seek work on the browser's own
 * player; the audio never uploads anywhere. A transcript without timestamps
 * still reads and captures — it just cannot seek. Missing transcripts and
 * addresses that will not play say so plainly, with the transcript path
 * still open underneath.
 */
export function Listener({ sourceId, onPickAnother }: ListenerProps) {
  const { api } = useApp();
  const [doc, setDoc] = useState<DiscoverySourceDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [audioProblem, setAudioProblem] = useState<string | null>(null);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const plainBody = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (id: string) =>
      api.fetchSource(id).then((loaded) => {
        setDoc(loaded);
        setLoadError(null);
        // An address the source came from (a URL) is offered as the audio
        // link, once — nothing else about the address is ever written back.
        if (/^https?:\/\//i.test(loaded.origin)) setAudioUrl(loaded.origin);
        return loaded;
      }),
    [api],
  );

  // Opening the transcript: fetched once per source (the page keys this
  // panel by id); the saved listening position is restored on playback.
  useEffect(() => {
    if (sourceId === null) return undefined;
    let current = true;
    load(sourceId)
      .catch((error: unknown) => {
        if (current) setLoadError(failureMessage(error, 'That transcript could not be opened.'));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load, sourceId]);

  const retry = () => {
    if (sourceId === null) return;
    setLoading(true);
    setLoadError(null);
    setDoc(null);
    setSelection(null);
    setResumedAt(null);
    void load(sourceId)
      .catch((error: unknown) => {
        setLoadError(failureMessage(error, 'That transcript could not be opened.'));
      })
      .finally(() => setLoading(false));
  };

  const transcript = useMemo(
    () => (doc === null ? { cues: [] as TranscriptCue[], timestamped: false } : parseTranscript(doc.content)),
    [doc],
  );

  /** Where the listener stopped: remembered as they listen. */
  const persist = (seconds: number) => {
    if (doc === null) return;
    void api
      .updateSource(doc.id, { position: { seconds: Math.max(0, Math.floor(seconds)) } })
      .catch(() => undefined);
  };

  const seek = (seconds: number) => {
    const element = audio.current;
    if (element !== null) {
      try {
        element.currentTime = seconds;
      } catch {
        // A player without a loaded source still lets the transcript work.
      }
    }
    setCurrentTime(seconds);
    setResumedAt(null);
    persist(seconds);
  };

  const togglePlay = () => {
    const element = audio.current;
    if (element === null) return;
    if (playing) {
      try {
        element.pause();
      } catch {
        // The button state below still tells the truth.
      }
      setPlaying(false);
      persist(element.currentTime || 0);
      return;
    }
    setAudioProblem(null);
    try {
      const result = element.play();
      if (result !== undefined && typeof result.catch === 'function') {
        result.catch(() => {
          setPlaying(false);
          setAudioProblem('That address could not be played. Check the link — the transcript below still works.');
        });
      }
      setPlaying(true);
    } catch {
      setPlaying(false);
      setAudioProblem('That address could not be played. Check the link — the transcript below still works.');
    }
  };

  const speak = (text: string) => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof window.SpeechSynthesisUtterance !== 'function'
    ) {
      setAudioProblem('Reading aloud is not available in this browser; the transcript is here to read.');
      return;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(text));
  };

  const clearSelection = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  /** Reading a selection inside one cue: the cue's own window comes along. */
  const readCueSelection = (cue: TranscriptCue) => {
    const active = window.getSelection();
    if (active === null || active.rangeCount === 0 || active.isCollapsed) {
      setSelection(null);
      return;
    }
    const label = active.toString().trim();
    if (label === '' || label.length > DISCOVERY_LIMITS.label) {
      setSelection(null);
      return;
    }
    setSelection({ kind: 'cue', label, cue });
  };

  /** Reading a selection in a transcript with no timestamps: an offset like any text. */
  const readPlainSelection = () => {
    const root = plainBody.current;
    const active = window.getSelection();
    if (root === null || active === null || active.rangeCount === 0 || active.isCollapsed) {
      setSelection(null);
      return;
    }
    const range = active.getRangeAt(0);
    if (!root.contains(range.startContainer)) {
      setSelection(null);
      return;
    }
    const label = active.toString().trim();
    if (label === '' || label.length > DISCOVERY_LIMITS.label) {
      setSelection(null);
      return;
    }
    setSelection({ kind: 'plain', label, offset: offsetWithin(root, range.startContainer, range.startOffset) });
  };

  if (sourceId === null) {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`}>
        <h2 className="font-serif text-xl font-semibold">Choose something to listen to</h2>
        <p className="text-sm text-muted">
          Import an .srt or .vtt transcript, or paste one — then listen with it here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to={discoverHref('import')} className={BUTTON_SECONDARY}>
            Import a transcript
          </Link>
          <button type="button" className={BUTTON_GHOST} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <div className={`${CARD} flex items-center gap-3 p-6 text-sm text-muted`} role="status">
        <Spinner className="size-5" />
        Opening the transcript…
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`} role="alert">
        <h2 className="font-serif text-xl font-semibold">That transcript did not open</h2>
        <p className="text-sm text-muted">{loadError}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON_SECONDARY} onClick={retry}>
            Try again
          </button>
          <button type="button" className={BUTTON_GHOST} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  if (doc === null) {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`}>
        <h2 className="font-serif text-xl font-semibold">That transcript is gone</h2>
        <p className="text-sm text-muted">It may have been deleted. Back to your texts to pick another.</p>
        <div className="flex flex-wrap gap-2">
          <Link to={discoverHref('import')} className={BUTTON_SECONDARY}>
            Import a transcript
          </Link>
          <button type="button" className={BUTTON_GHOST} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  if (doc.content.trim() === '') {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`}>
        <h2 className="font-serif text-xl font-semibold">{doc.title}</h2>
        <p className="text-sm text-muted">This source has no transcript in it yet.</p>
        <div className="flex flex-wrap gap-2">
          <Link to={discoverHref('import')} className={BUTTON_SECONDARY}>
            Import a transcript
          </Link>
          <button type="button" className={BUTTON_GHOST} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  const panel =
    selection === null ? null : selection.kind === 'cue' ? (
      <SelectionPanel
        key={`cue:${selection.cue.start}:${selection.label}`}
        sourceId={doc.id}
        content={doc.content}
        label={selection.label}
        cueStart={Math.round(selection.cue.from * 1000)}
        cueEnd={Math.round(selection.cue.to * 1000)}
        context={selection.cue.text}
        onDone={clearSelection}
      />
    ) : (
      <SelectionPanel
        key={`offset:${selection.offset}:${selection.label}`}
        sourceId={doc.id}
        content={doc.content}
        label={selection.label}
        offset={selection.offset}
        onDone={clearSelection}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={`${BUTTON_GHOST} h-8 px-2`} onClick={onPickAnother}>
          ← All texts
        </button>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs font-medium text-muted">
          {KIND_LABELS[doc.kind]}
        </span>
      </div>

      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold tracking-tight">{doc.title}</h2>
        {doc.origin !== '' && <p className="text-xs text-muted">{doc.origin}</p>}
      </header>

      <section aria-label="Audio" className={`${CARD} flex flex-col gap-3 p-4`}>
        <label className="grid gap-1" htmlFor="listener-audio-url">
          <span className={LABEL}>Audio address (optional — a link your browser can play)</span>
          <input
            id="listener-audio-url"
            className={INPUT}
            value={audioUrl}
            onChange={(event) => {
              setAudioUrl(event.target.value);
              setAudioProblem(null);
            }}
            placeholder="https://example.com/episode-12.mp3"
            inputMode="url"
          />
        </label>

        <audio
          ref={audio}
          src={audioUrl.trim() === '' ? undefined : audioUrl.trim()}
          preload="metadata"
          onLoadedMetadata={() => {
            const element = audio.current;
            if (element !== null && !Number.isNaN(element.duration)) setDuration(element.duration);
            const resume = doc.position.seconds ?? 0;
            if (
              element !== null &&
              resume > 0 &&
              (element.currentTime === 0 || Number.isNaN(element.currentTime))
            ) {
              try {
                element.currentTime = resume;
              } catch {
                // The saved time is still shown below even if the player refuses it.
              }
              setCurrentTime(resume);
            }
            setResumedAt(resume > 0 ? resume : null);
          }}
          onTimeUpdate={() => {
            const element = audio.current;
            if (element !== null) setCurrentTime(element.currentTime);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            const element = audio.current;
            setPlaying(false);
            if (element !== null) persist(element.currentTime || 0);
          }}
          onEnded={() => {
            const element = audio.current;
            setPlaying(false);
            // The last second listened to is part of where they stopped.
            persist(element?.currentTime || element?.duration || 0);
          }}
          onError={() => {
            setPlaying(false);
            setAudioProblem(
              'That address could not be played. Check the link — the transcript below still works.',
            );
          }}
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={togglePlay}
            disabled={audioUrl.trim() === ''}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            <Icon name={playing ? 'close' : 'right'} className="size-4" />
            {playing ? 'Pause' : 'Play'}
          </button>
          <input
            type="range"
            aria-label="Seek in the audio"
            className="min-w-40 flex-1 accent-accent"
            min={0}
            max={Number.isNaN(duration) ? 0 : Math.floor(duration)}
            step={1}
            value={Math.min(currentTime, Number.isNaN(duration) ? currentTime : duration)}
            disabled={audioUrl.trim() === ''}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span className="tabular-nums text-sm text-muted" role="status">
            {clockTime(currentTime)} / {Number.isNaN(duration) ? '–:––' : clockTime(duration)}
          </span>
        </div>

        {audioUrl.trim() === '' && (
          <p className={HELP}>
            No audio yet — the transcript below still works: select a word to capture it with its time. Give an
            address to play sound; nothing is ever uploaded from your device.
          </p>
        )}
        {resumedAt !== null && (
          <p className={HELP} role="status">
            Resumed at {clockTime(resumedAt)} where you stopped listening.
          </p>
        )}
        {audioProblem !== null && (
          <p role="alert" className="text-xs font-medium text-bad-ink">
            {audioProblem}
          </p>
        )}
      </section>

      <section aria-label="Transcript" className={`${CARD} flex flex-col gap-3 p-4`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold tracking-tight">Transcript</h3>
          <Link
            to={discoverHref('import')}
            className="text-xs font-semibold text-accent underline-offset-2 hover:underline"
          >
            Import or paste a transcript
          </Link>
        </div>

        {transcript.timestamped ? (
          <>
            <p className={HELP}>
              Select words in a line to save or mark them with that line's time. Press a time to seek.
            </p>
            <ol className="flex flex-col divide-y divide-line">
              {transcript.cues.map((cue) => {
                const active = cue.from <= currentTime && currentTime < cue.to;
                return (
                  <li
                    key={`${cue.start}-${cue.from}`}
                    className={`flex items-start gap-3 px-1 py-2 ${active ? 'rounded-lg bg-accent-soft' : ''}`}
                    aria-current={active ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer rounded-lg border border-line px-2 py-1 font-mono text-xs tabular-nums text-muted hover:border-muted"
                      onClick={() => seek(cue.from)}
                      aria-label={`Seek to ${clockTime(cue.from)}`}
                    >
                      {clockTime(cue.from)}
                    </button>
                    <span
                      className="min-w-0 flex-1 cursor-text whitespace-pre-wrap text-sm"
                      onMouseUp={() => readCueSelection(cue)}
                    >
                      {cue.text}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer rounded-lg p-1.5 text-muted hover:bg-line/40"
                      onClick={() => speak(cue.text)}
                      aria-label={`Read the line at ${clockTime(cue.from)} aloud`}
                    >
                      <Icon name="speaker" className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <>
            <p className={HELP}>
              This transcript has no timestamps: it reads like text, and selections keep their sentence rather than
              a time. An .srt or .vtt file would bring times with it.
            </p>
            <div
              ref={plainBody}
              onMouseUp={readPlainSelection}
              onKeyUp={(event) => {
                if (event.shiftKey || event.key.startsWith('Arrow')) readPlainSelection();
              }}
              className="cursor-text whitespace-pre-wrap rounded-xl border border-line p-4 text-sm leading-relaxed"
              data-testid="listener-body"
            >
              {doc.content}
            </div>
          </>
        )}
      </section>

      {panel}
    </div>
  );
}
