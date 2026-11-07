/**
 * The chests' own sounds, synthesised with the Web Audio API so the app ships
 * no audio files. Every cue is short and quiet on purpose: the reward is the
 * card, not the noise.
 *
 * Browsers only allow audio after a gesture, which is exactly when a chest is
 * opened, so the context is created on the first cue and never before.
 */

export type GachaCue = 'tap' | 'charge' | 'burst' | 'common' | 'rare' | 'epic' | 'legendary' | 'duplicate';

let context: AudioContext | null = null;
let muted = false;

export function setGachaSoundMuted(next: boolean): void {
  muted = next;
}

export function gachaSoundMuted(): boolean {
  return muted;
}

function audio(): AudioContext | null {
  if (muted) return null;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

/** One shaped tone: a short attack and a natural fall, so nothing clicks. */
function tone(
  at: number,
  frequency: number,
  duration: number,
  options: { type?: OscillatorType; gain?: number; slideTo?: number } = {},
): void {
  const ctx = audio();
  if (ctx === null) return;
  const start = ctx.currentTime + at;
  const oscillator = ctx.createOscillator();
  const amp = ctx.createGain();
  oscillator.type = options.type ?? 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  if (options.slideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(options.slideTo, start + duration);
  const peak = options.gain ?? 0.05;
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(amp).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

/** A breath of filtered noise, for the moment the lid gives way. */
function noise(at: number, duration: number, gain = 0.06): void {
  const ctx = audio();
  if (ctx === null) return;
  const start = ctx.currentTime + at;
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < frames; index += 1) {
    // Fades out across the buffer, so it ends in silence rather than a cut.
    data[index] = (Math.random() * 2 - 1) * (1 - index / frames) ** 2;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1800;
  const amp = ctx.createGain();
  amp.gain.value = gain;
  source.connect(filter).connect(amp).connect(ctx.destination);
  source.start(start);
}

export function playGachaCue(cue: GachaCue): void {
  switch (cue) {
    case 'tap':
      tone(0, 320, 0.07, { type: 'triangle', gain: 0.03, slideTo: 240 });
      return;
    case 'charge':
      tone(0, 110, 0.5, { type: 'sawtooth', gain: 0.02, slideTo: 220 });
      tone(0.1, 220, 0.4, { type: 'sine', gain: 0.015, slideTo: 330 });
      return;
    case 'burst':
      noise(0, 0.35, 0.07);
      tone(0, 180, 0.18, { type: 'triangle', gain: 0.05, slideTo: 90 });
      return;
    case 'common':
      tone(0, 440, 0.16, { gain: 0.035 });
      tone(0.09, 550, 0.2, { gain: 0.03 });
      return;
    case 'rare':
      tone(0, 523.25, 0.16, { type: 'triangle', gain: 0.04 });
      tone(0.1, 659.25, 0.22, { type: 'triangle', gain: 0.035 });
      tone(0.2, 783.99, 0.3, { type: 'triangle', gain: 0.03 });
      return;
    case 'epic':
      [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) =>
        tone(index * 0.09, frequency, 0.32, { type: 'triangle', gain: 0.038 }),
      );
      noise(0, 0.2, 0.02);
      return;
    case 'legendary':
      [392, 523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((frequency, index) =>
        tone(index * 0.11, frequency, 0.5, { type: 'sine', gain: 0.045 }),
      );
      tone(0.5, 1567.98, 0.7, { type: 'triangle', gain: 0.03 });
      noise(0, 0.5, 0.03);
      return;
    case 'duplicate':
      tone(0, 300, 0.12, { type: 'square', gain: 0.02, slideTo: 200 });
      return;
  }
}
