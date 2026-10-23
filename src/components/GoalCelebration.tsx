/**
 * The moment both daily goals are met: the two goal rings draw together into
 * a full moon, the room fills with its light and the streak turns over to the
 * new day. It plays once a day per account, at the moment the day is
 * completed — after the answer, the word added or the import that completes
 * it — or on the next visit when the day was completed somewhere else.
 *
 * It only reads the goals: nothing here can change what counts or when.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReviewActionResponse, StudyGoalsResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { pick } from '../lib/i18n.js';
import { fetchShared, knownStudyGoals, subscribeGoalWork, subscribeStudyGoals } from './StudyGoals.js';
import { BUTTON_PRIMARY } from './ui.js';

/** The day each account last celebrated, kept on this device so a reload does not play it twice. */
const celebratedKey = (accountId: string) => `vocab.goals-celebrated.${accountId}`;

function celebratedOn(accountId: string): string | null {
  try {
    return window.localStorage.getItem(celebratedKey(accountId));
  } catch {
    return null;
  }
}

function markCelebrated(accountId: string, day: string) {
  try {
    window.localStorage.setItem(celebratedKey(accountId), day);
  } catch {
    // Without storage it may play again after a reload; nothing else depends on it.
  }
}

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reduceMotion === 'true') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Waits this long after the last saved answer before asking, so a quick run of answers asks once. */
const SETTLE_MS = 600;

/**
 * Watches for the day being completed. Asks for the goals only when the work
 * since they were last seen could have completed them, so a long session does
 * not ask after every answer.
 */
export function GoalCelebration() {
  const { api, sync, accountId } = useApp();
  const [shown, setShown] = useState<StudyGoalsResponse | null>(null);

  useEffect(() => {
    let last = knownStudyGoals(api);
    let answers = 0;
    let added = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const consider = (goals: StudyGoalsResponse) => {
      last = goals;
      answers = 0;
      added = 0;
      // Only goals the reviewer chose make a streak, so only they are celebrated.
      if (!goals.available || !goals.chosen || !goals.streak.metToday) return;
      if (celebratedOn(accountId) === goals.today) return;
      markCelebrated(accountId, goals.today);
      setShown(goals);
    };

    const couldBeMet = () => {
      if (last === undefined) return true;
      if (last.streak.metToday) return false;
      // Generous on purpose: a check too many costs one request, a check missed costs the moment.
      const reviews = last.reviews.met || answers >= Math.min(last.reviews.remaining, last.due.total);
      const newWords = last.newWords.met || added >= last.newWords.remaining;
      return reviews && newWords;
    };

    const checkSoon = () => {
      if (!couldBeMet()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void fetchShared(api).catch(() => undefined), SETTLE_MS);
    };

    const stopGoals = subscribeStudyGoals((source, goals) => {
      if (source === api) consider(goals);
    });
    const stopWork = subscribeGoalWork(() => {
      added = Number.POSITIVE_INFINITY;
      checkSoon();
    });
    const stopEvents = sync.subscribeEvents((event) => {
      if (event.type !== 'settled') return;
      if (event.op.kind === 'review_action') {
        if ((event.value as ReviewActionResponse | undefined)?.outcome !== 'applied') return;
        answers += 1;
      } else if (event.op.kind === 'vocab_create') {
        added += 1;
      } else {
        return;
      }
      checkSoon();
    });
    // Goals already on the page (a dashboard opened first) may show a day completed elsewhere.
    if (last !== undefined) consider(last);

    return () => {
      clearTimeout(timer);
      stopGoals();
      stopWork();
      stopEvents();
    };
  }, [api, sync, accountId]);

  if (shown === null) return null;
  return <Moonrise goals={shown} onClose={() => setShown(null)} />;
}

/** A fixed scatter of stars, the same on every visit: position, size, brightness, timing. */
const STARS = Array.from({ length: 42 }, (_, index) => {
  const noise = (salt: number) => {
    const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return value - Math.floor(value);
  };
  return {
    left: noise(1) * 100,
    top: noise(2) * 100,
    size: 1 + noise(3) * 1.8,
    brightness: 0.35 + noise(4) * 0.55,
    delay: 120 + noise(5) * 900,
    twinkle: 2600 + noise(6) * 2600,
  };
});

/** Moonlight thrown off as the rings meet. */
const SPARKS = Array.from({ length: 16 }, (_, index) => ({
  angle: index * (360 / 16) + ((index * 37) % 11) - 5,
  reach: 118 + ((index * 53) % 5) * 14,
  size: 3 + (index % 3),
  delay: 930 + (index % 4) * 40,
  tone: index % 3 === 0 ? 'var(--good-ink)' : index % 3 === 1 ? 'var(--accent-hover)' : 'var(--ink)',
}));

/** When the scene has settled enough that a key press is meant for it, not left over from the card. */
const READY_MS = 1700;
const LEAVE_MS = 260;

function Moonrise({ goals, onClose }: { goals: StudyGoalsResponse; onClose: () => void }) {
  const language = useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const streak = goals.streak.current;
  const before = Math.max(0, streak - 1);
  const best = streak > 1 && streak >= goals.streak.longest;

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    else element.setAttribute('open', '');
    // The answer keys are still under the reviewer's fingers: hold focus on the scene, not the button.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stage.current?.focus();
    const calm = reducedMotion();
    const settle = setTimeout(
      () => {
        setReady(true);
        button.current?.focus();
      },
      calm ? 400 : READY_MS,
    );
    // A small knock as the rings meet, where the device has one.
    const knock = calm ? undefined : setTimeout(() => navigator.vibrate?.([14, 70, 26]), 920);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(settle);
      clearTimeout(knock);
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
      if (typeof element.close === 'function' && element.open) element.close();
      else element.removeAttribute('open');
    };
  }, []);

  // The review shortcuts listen on the window; none of them may reach the card behind.
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const swallow = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (!ready && event.key !== 'Tab') event.preventDefault();
    };
    element.addEventListener('keydown', swallow);
    return () => element.removeEventListener('keydown', swallow);
  }, [ready]);

  const close = () => {
    if (!ready || leaving) return;
    setLeaving(true);
    setTimeout(onClose, reducedMotion() ? 0 : LEAVE_MS);
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="moonrise-title"
      aria-describedby="moonrise-detail"
      data-leaving={leaving || undefined}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== button.current) close();
      }}
      className="moonrise m-0 h-dvh max-h-none w-screen max-w-none overflow-x-hidden overflow-y-auto border-0 bg-transparent p-0 text-ink"
    >
      <div className="moonrise-sky fixed inset-0" aria-hidden="true">
        {STARS.map((star, index) => (
          <span
            key={index}
            className="moonrise-star"
            style={
              {
                left: `${star.left}%`,
                top: `${star.top}%`,
                '--s': `${star.size}px`,
                '--o': star.brightness,
                '--d': `${star.delay}ms`,
                '--t': `${star.twinkle}ms`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div
        ref={stage}
        tabIndex={-1}
        className="relative flex min-h-full flex-col items-center justify-center px-4 pt-10 pb-[max(2.5rem,env(safe-area-inset-bottom))] text-center outline-none"
      >
        <div className="relative size-64 shrink-0" aria-hidden="true">
          <div className="moonrise-glow absolute -inset-16 rounded-full" />
          <span
            className="moonrise-halo absolute inset-[3.5rem] rounded-full"
            style={{ '--d': '940ms' } as CSSProperties}
          />
          <span
            className="moonrise-halo absolute inset-[3.5rem] rounded-full"
            style={{ '--d': '1140ms' } as CSSProperties}
          />
          {SPARKS.map((spark, index) => (
            <span
              key={index}
              className="moonrise-spark"
              style={
                {
                  '--a': `${spark.angle}deg`,
                  '--r': `${spark.reach}px`,
                  '--s': `${spark.size}px`,
                  '--d': `${spark.delay}ms`,
                  background: spark.tone,
                } as CSSProperties
              }
            />
          ))}
          <MeltingRing side="left" color="var(--accent)" label={`${goals.newWords.done}/${goals.newWords.target}`} />
          <MeltingRing side="right" color="var(--ink)" label={`${goals.reviews.done}/${goals.reviews.target}`} />
          <div className="moonrise-moon absolute inset-[3.5rem] rounded-full">
            <span className="absolute left-[22%] top-[26%] size-[22%] rounded-full bg-[rgb(8_16_32_/_0.045)]" />
            <span className="absolute left-[58%] top-[56%] size-[16%] rounded-full bg-[rgb(8_16_32_/_0.05)]" />
            <span className="absolute left-[60%] top-[22%] size-[9%] rounded-full bg-[rgb(8_16_32_/_0.045)]" />
            <svg viewBox="0 0 100 100" className="absolute inset-0 size-full">
              <path
                className="moonrise-check"
                d="M31 52 L45 65 L70 37"
                fill="none"
                stroke="var(--on-accent)"
                strokeOpacity="0.82"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
              />
            </svg>
          </div>
        </div>

        <p
          className="moonrise-rise mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-faint"
          style={{ '--d': '1220ms' } as CSSProperties}
        >
          {pick(language, 'Both goals met', 'Đạt cả hai mục tiêu')}
        </p>
        <h2
          id="moonrise-title"
          className="moonrise-rise mt-3 font-serif text-4xl font-semibold tracking-tight text-ink sm:text-5xl"
          style={{ '--d': '1300ms' } as CSSProperties}
        >
          {pick(language, 'Today is complete.', 'Hôm nay đã trọn vẹn.')}
        </h2>
        <p
          id="moonrise-detail"
          className="moonrise-rise mt-3 max-w-sm text-sm leading-relaxed text-muted"
          style={{ '--d': '1380ms' } as CSSProperties}
        >
          {pick(
            language,
            `${goals.newWords.done} new ${goals.newWords.done === 1 ? 'word' : 'words'} and ${goals.reviews.done} ${goals.reviews.done === 1 ? 'review' : 'reviews'} today.`,
            `Hôm nay: ${goals.newWords.done} từ mới và ${goals.reviews.done} lượt ôn.`,
          )}
        </p>

        <div className="moonrise-rise mt-7 flex flex-col items-center" style={{ '--d': '1480ms' } as CSSProperties}>
          <div className="moonrise-pop relative h-14 overflow-hidden font-serif text-5xl font-semibold leading-[3.5rem] tabular-nums text-ink">
            <span className="invisible">{streak}</span>
            {before !== streak && (
              <span className="moonrise-roll-out absolute inset-0" aria-hidden="true">
                {before}
              </span>
            )}
            <span className="moonrise-roll-in absolute inset-0">{streak}</span>
          </div>
          <p className="mt-1 text-sm font-medium text-muted">
            {streak === 1
              ? pick(language, 'Your streak starts today.', 'Chuỗi ngày bắt đầu từ hôm nay.')
              : pick(language, `days in a row`, `ngày liên tiếp`)}
          </p>
          {best && (
            <p
              className="moonrise-rise mt-2 rounded-full bg-good-soft px-3 py-1 text-xs font-semibold text-good-ink"
              style={{ '--d': '2150ms' } as CSSProperties}
            >
              {pick(language, 'Your longest streak yet', 'Chuỗi dài nhất của bạn')}
            </p>
          )}
        </div>

        <button
          ref={button}
          type="button"
          className={`moonrise-rise mt-9 min-w-36 ${BUTTON_PRIMARY}`}
          style={{ '--d': '1600ms' } as CSSProperties}
          onClick={close}
        >
          {pick(language, 'Continue', 'Tiếp tục')}
        </button>
      </div>
    </dialog>
  );
}

/** One of the two goal rings, full, sliding in from its side to meet the other. */
function MeltingRing({ side, color, label }: { side: 'left' | 'right'; color: string; label: string }) {
  return (
    <div className={`moonrise-ring moonrise-ring-${side} absolute inset-[3.5rem]`}>
      <svg viewBox="0 0 100 100" className="size-full">
        <circle cx="50" cy="50" r="38" fill="rgb(8 16 32 / 0.55)" stroke={color} strokeWidth="7" />
      </svg>
      <span className="moonrise-ring-label absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums text-ink">
        {label}
      </span>
    </div>
  );
}
