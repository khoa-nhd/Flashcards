/**
 * Reading a transcript the way a listener needs it: as cues with a window
 * of time, so a selection can be marked with the seconds it was spoken at
 * and a click can seek the audio there.
 *
 * SubRip (.srt) and WebVTT (.vtt) are both line-based and both use
 * `start --> end`; VTT writes its decimals with a dot where SRT writes a
 * comma, and may trail settings after the end time. A transcript without
 * any timestamps is not an error: it comes back with no cues, and the
 * listener reads it as plain text instead.
 */
export interface TranscriptCue {
  /** Where the cue's text begins in the original content, for selection offsets. */
  start: number;
  end: number;
  /** Seconds. */
  from: number;
  to: number;
  text: string;
}

export interface ParsedTranscript {
  cues: TranscriptCue[];
  /** False when the content carries no timestamps: plain reading, no seeking. */
  timestamped: boolean;
}

const TIMED_LINE = /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

/** `hh:mm:ss,mmm`, `mm:ss.mmm` and friends, as seconds. Null when unreadable. */
export function parseTimestamp(value: string): number | null {
  const parts = value.replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length === 1 ? Number(parts.pop()) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return null;
  if (minutes > 59 || hours < 0 || minutes < 0 || seconds < 0) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Formats seconds as m:ss or h:mm:ss, the way a player shows them. */
export function clockTime(total: number): string {
  const seconds = Math.max(0, Math.floor(total));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Splits SRT/VTT content into cues. Plain text yields `cues: []` with
 * `timestamped: false` — the caller then shows the content as it stands.
 */
export function parseTranscript(content: string): ParsedTranscript {
  const lines = content.split(/\r?\n/);
  const cues: TranscriptCue[] = [];
  let cursor = 0; // character offset of the current line's start in the original content
  let textStart = 0;
  let cueStart = -1;
  let cueFrom = 0;
  let cueTo = 0;

  const flush = (textEnd: number) => {
    if (cueStart < 0) return;
    const text = content.slice(textStart, textEnd).replace(/\s+$/, '');
    if (text.trim() !== '') {
      cues.push({ start: cueStart, end: textEnd, from: cueFrom, to: cueTo, text });
    }
    cueStart = -1;
  };

  for (const line of lines) {
    // The exact start of this line in the original content, so offsets hold
    // for \n and \r\n alike; `cursor` is where the line itself begins.
    const at = content.indexOf(line, cursor);
    const timed = TIMED_LINE.exec(line);
    if (timed !== null) {
      // Flush the cue the previous block of text belonged to…
      flush(at);
      const from = parseTimestamp(timed[1]!);
      const to = parseTimestamp(timed[2]!);
      if (from === null || to === null) {
        // An unreadable timestamp is a line this parser does not stand behind;
        // skip the line and let the next one speak for itself.
        cursor = at + line.length;
        if (content[cursor] === '\r') cursor += 1;
        if (content[cursor] === '\n') cursor += 1;
        continue;
      }
      cueStart = at;
      cueFrom = from;
      cueTo = Math.max(from, to);
      textStart = at + line.length;
      if (content[textStart] === '\r') textStart += 1;
      if (content[textStart] === '\n') textStart += 1;
    } else if (cueStart >= 0 && line.trim() === '') {
      // …and the blank line closes it: everything since the arrow was text.
      flush(at);
    }
    cursor = at + line.length;
    if (content[cursor] === '\r') cursor += 1;
    if (content[cursor] === '\n') cursor += 1;
  }
  flush(content.length);

  return { cues, timestamped: cues.length > 0 };
}

/** True when the content reads like a timestamped transcript rather than prose. */
export function looksLikeTranscript(content: string): boolean {
  return TIMED_LINE.test(content.slice(0, 4000));
}
