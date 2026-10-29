/**
 * The two FSRS daily goals: new words, and everything due today. The review
 * goal is the day's due queue itself, never a number typed in beforehand. They
 * drive the streak and nothing else; a session never stops when a goal is met,
 * and a goal that cannot be reached because nothing is left is explained
 * rather than punished.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StudyGoalsResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { Link } from './Link.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from './ui.js';

export interface StudyGoalsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: StudyGoalsResponse | null;
  error: string | null;
}

/**
 * The latest goals each signed-in account was told, kept for as long as the
 * page is open: coming back to a page shows them at once while a fresh copy is
 * fetched behind them. Keyed by the account's API object, so one account never
 * sees another's.
 */
const lastGoals = new WeakMap<object, StudyGoalsResponse>();
/** A request already on its way, shared by every part of the page that asks at the same time. */
const inFlight = new WeakMap<object, Promise<StudyGoalsResponse>>();

type GoalsListener = (api: object, data: StudyGoalsResponse) => void;
/** Told every time fresh goals arrive, wherever they were asked for: what the celebration watches. */
const goalsListeners = new Set<GoalsListener>();
/** Told when something outside the outbox, such as an import, may have moved today's goals. */
const workListeners = new Set<() => void>();

function remember(api: object, data: StudyGoalsResponse) {
  lastGoals.set(api, data);
  for (const listener of goalsListeners) listener(api, data);
}

export function subscribeStudyGoals(listener: GoalsListener): () => void {
  goalsListeners.add(listener);
  return () => goalsListeners.delete(listener);
}

/** The goals this account was last told, if any, without asking again. */
export function knownStudyGoals(api: object): StudyGoalsResponse | undefined {
  return lastGoals.get(api);
}

/** Says that today's goals may have moved, for work that does not pass through the outbox. */
export function studyGoalsMayHaveMoved(): void {
  for (const listener of workListeners) listener();
}

export function subscribeGoalWork(listener: () => void): () => void {
  workListeners.add(listener);
  return () => workListeners.delete(listener);
}

export function fetchShared(api: { fetchStudyGoals(): Promise<StudyGoalsResponse> }): Promise<StudyGoalsResponse> {
  const pending = inFlight.get(api);
  if (pending !== undefined) return pending;
  const request = api.fetchStudyGoals().then(
    (data) => {
      inFlight.delete(api);
      remember(api, data);
      return data;
    },
    (error: unknown) => {
      inFlight.delete(api);
      throw error;
    },
  );
  inFlight.set(api, request);
  return request;
}

/** Loads the goals only where the server can keep them, and exposes a reload. */
export function useStudyGoals(enabled: boolean) {
  const { api } = useApp();
  const [state, setState] = useState<StudyGoalsState>(() => {
    const known = lastGoals.get(api);
    return known === undefined ? { status: 'idle', data: null, error: null } : { status: 'ready', data: known, error: null };
  });

  const reload = useCallback(async () => {
    if (!enabled) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }
    setState((current) => ({ ...current, status: current.data === null ? 'loading' : 'ready', error: null }));
    try {
      const data = await fetchShared(api);
      setState({ status: 'ready', data, error: null });
    } catch (cause) {
      setState((current) => ({
        status: current.data === null ? 'error' : 'ready',
        data: current.data,
        error: cause instanceof ApiError ? cause.message : 'Could not load your daily goals.',
      }));
    }
  }, [api, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const adopt = (data: StudyGoalsResponse) => {
    remember(api, data);
    setState({ status: 'ready', data, error: null });
  };
  return { ...state, reload, adopt };
}

/** The compact card's shape, drawn while the goals load, so nothing moves when they arrive. */
export function StudyGoalsSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4" aria-hidden="true">
      <div className="flex animate-pulse flex-col gap-4 motion-reduce:animate-none">
        <div className="flex flex-col gap-2">
          <div className="h-2.5 w-24 rounded-full bg-line" />
          <div className="h-3 w-4/5 rounded-full bg-line/70" />
        </div>
        <div className="h-7 w-20 rounded-full bg-line/70" />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1].map((key) => (
            <div key={key} className="flex flex-col items-center gap-2">
              <div className="size-24 rounded-full border-[7px] border-line" />
              <div className="h-3 w-20 rounded-full bg-line/70" />
              <div className="h-2.5 w-28 rounded-full bg-line/50" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The streak warning starts this many minutes before the day ends, and grows urgent at the second. */
export const STREAK_WARNING_MINUTES = 6 * 60;
export const STREAK_URGENT_MINUTES = 2 * 60;

/**
 * Minutes left of `day` in the account's time zone, or `null` when it is
 * already another day there: goals from before midnight say nothing about now.
 */
export function minutesLeftOf(day: string, timeZone: string, now: Date): number | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  if (`${part('year')}-${part('month')}-${part('day')}` !== day) return null;
  return 24 * 60 - (Number(part('hour')) * 60 + Number(part('minute')));
}

/** The time, kept current to the half minute while the card is shown. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export interface StreakRisk {
  minutesLeft: number;
  urgent: boolean;
}

/**
 * A streak still standing from yesterday is lost at midnight unless today is
 * met. Close to midnight that is worth saying; earlier in the day it is not.
 */
export function streakRisk(data: StudyGoalsResponse, now: Date): StreakRisk | null {
  if (!data.available || !data.chosen || data.streak.metToday || data.streak.current === 0) return null;
  const minutesLeft = minutesLeftOf(data.today, data.timeZone, now);
  if (minutesLeft === null || minutesLeft <= 0 || minutesLeft > STREAK_WARNING_MINUTES) return null;
  return { minutesLeft, urgent: minutesLeft <= STREAK_URGENT_MINUTES };
}

function timeLeft(language: UiLanguage, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return pick(language, `${rest} min`, `${rest} phút`);
  if (rest === 0) return pick(language, `${hours} h`, `${hours} giờ`);
  return pick(language, `${hours} h ${rest} min`, `${hours} giờ ${rest} phút`);
}

/** The moon from the celebration, waning as the evening runs out. */
function WaningMoon({ fraction, urgent }: { fraction: number; urgent: boolean }) {
  // The shadow slides in from the right: a full moon at six hours left, a sliver at the end.
  const shadow = 14 + 16 * Math.max(0, Math.min(1, fraction));
  const id = `waning-${Math.round(shadow * 10)}`;
  return (
    <svg
      viewBox="0 0 24 24"
      className={`mt-0.5 size-6 shrink-0 ${urgent ? 'animate-pulse motion-reduce:animate-none' : ''}`}
      aria-hidden="true"
    >
      <defs>
        <mask id={id}>
          <rect width="24" height="24" fill="white" />
          <circle cx={shadow} cy="12" r="9" fill="black" />
        </mask>
      </defs>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="9" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

function StreakWarning({ data, risk, language }: { data: StudyGoalsResponse; risk: StreakRisk; language: UiLanguage }) {
  const days = data.streak.current;
  const newLeft = data.newWords.met ? 0 : data.newWords.remaining;
  const reviewsLeft = data.reviews.met ? 0 : data.reviews.remaining;
  const missing = [
    newLeft > 0 ? pick(language, `${newLeft} new ${newLeft === 1 ? 'word' : 'words'}`, `${newLeft} từ mới`) : null,
    reviewsLeft > 0
      ? pick(language, `${reviewsLeft} ${reviewsLeft === 1 ? 'review' : 'reviews'}`, `${reviewsLeft} lượt ôn`)
      : null,
  ].filter((item): item is string => item !== null);
  const tone = risk.urgent
    ? 'border-bad/35 bg-bad-soft text-bad-ink'
    : 'border-[rgb(236_201_143_/_0.3)] bg-warn-soft text-warn-ink';
  const action =
    'inline-flex min-h-9 items-center rounded-lg border border-current/30 px-3 text-xs font-semibold transition-colors hover:bg-current/10';

  return (
    <section
      aria-label={pick(language, 'Streak at risk', 'Chuỗi ngày sắp mất')}
      className={`mt-3 flex gap-3 rounded-xl border px-3 py-3 ${tone}`}
    >
      <WaningMoon fraction={risk.minutesLeft / STREAK_WARNING_MINUTES} urgent={risk.urgent} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">
          {pick(
            language,
            `Your ${days}-day streak ends in ${timeLeft(language, risk.minutesLeft)}.`,
            `Chuỗi ${days} ngày sẽ mất sau ${timeLeft(language, risk.minutesLeft)}.`,
          )}
        </p>
        {missing.length > 0 && (
          <p className="mt-0.5 text-xs leading-relaxed opacity-85">
            {pick(language, `Still to do: ${missing.join(' and ')}.`, `Còn thiếu: ${missing.join(' và ')}.`)}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {reviewsLeft > 0 && (
            <Link to={ROUTES.review} className={action}>
              {pick(language, 'Review now', 'Ôn ngay')}
            </Link>
          )}
          {newLeft > 0 && (
            <Link to={ROUTES.add} className={action}>
              {pick(language, 'Add words', 'Thêm từ')}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function partProgress(part: StudyGoalsResponse['newWords']): number {
  if (part.met) return 1;
  if (part.target === 0) return 1;
  return Math.min(1, part.done / part.target);
}

function GoalRing({
  label,
  part,
  language,
  tone,
}: {
  label: string;
  part: StudyGoalsResponse['newWords'];
  language: UiLanguage;
  tone: 'new' | 'review';
}) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const progress = partProgress(part);
  const color = tone === 'new' ? 'var(--accent)' : 'var(--ink)';
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center">
      <div className="relative size-24">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="7" />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
          <span className="text-xl font-semibold tabular-nums text-ink">
            {part.done}/{part.target}
          </span>
          {part.met && <span className="mt-1 text-[0.625rem] font-medium uppercase tracking-wider text-accent">✓</span>}
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          {tone === 'review'
            ? part.met
              ? pick(language, 'All due reviewed', 'Đã ôn hết từ đến hạn')
              : part.remaining > 0
                ? pick(language, `${part.remaining} left`, `còn ${part.remaining}`)
                : pick(language, 'Nothing due', 'Không có từ đến hạn')
            : part.exhausted && !part.met
              ? pick(
                  language,
                  'No new words left. Maintenance mode lets this goal be 0.',
                  'Không còn từ mới. Chế độ duy trì cho phép mục tiêu này bằng 0.',
                )
              : part.met
                ? pick(language, 'Goal met', 'Đã đạt')
                : pick(language, `${part.remaining} left`, `còn ${part.remaining}`)}
        </p>
      </div>
    </div>
  );
}

export function StudyGoalsCard({
  data,
  onSaved,
  compact = false,
}: {
  data: StudyGoalsResponse;
  onSaved: (next: StudyGoalsResponse) => void;
  /** The smaller form used after a session. */
  compact?: boolean;
}) {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const [editing, setEditing] = useState(false);
  const [newWords, setNewWords] = useState(String(data.goals.newWords));
  const [practice, setPractice] = useState(String(data.goals.practice));
  const [maintenance, setMaintenance] = useState(data.goals.maintenanceMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const risk = streakRisk(data, useNow());

  const beginEdit = () => {
    setNewWords(String(data.goals.newWords));
    setPractice(String(data.goals.practice));
    setMaintenance(data.goals.maintenanceMode);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const nextNew = maintenance ? 0 : Number(newWords);
    const nextPractice = Number(practice);
    if (!Number.isInteger(nextNew) || nextNew < 0 || !Number.isInteger(nextPractice) || nextPractice < 0) {
      setError(
        pick(
          language,
          'New words and practice must be 0 or more.',
          'Số từ mới và thực hành phải từ 0 trở lên.',
        ),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveStudyGoals({
        newWords: nextNew,
        // The review goal is the day's due queue, so nothing here changes it.
        reviews: data.goals.reviews,
        practice: nextPractice,
        maintenanceMode: maintenance,
      });
      onSaved(next);
      setEditing(false);
      toasts.show({ message: pick(language, 'Daily goals saved.', 'Đã lưu mục tiêu ngày.') });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : pick(language, 'Could not save the goals.', 'Không thể lưu mục tiêu.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label={pick(language, 'Daily goals', 'Mục tiêu ngày')}
      className={`${compact ? 'rounded-xl border border-line bg-surface p-4' : 'rounded-2xl border border-accent/30 bg-accent-soft/30 p-5'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">
            {pick(language, 'Daily goals', 'Mục tiêu ngày')}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {data.streak.metToday
              ? pick(language, 'All goals are met today.', 'Hôm nay đã đạt tất cả mục tiêu.')
              : pick(
                  language,
                  'A streak needs all goals. Reaching them never stops a session.',
                  'Chuỗi ngày cần đủ các mục tiêu. Đạt mục tiêu không làm dừng buổi ôn.',
                )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold tabular-nums ${
              risk === null
                ? 'border-line-strong text-muted'
                : risk.urgent
                  ? 'border-bad/40 text-bad-ink'
                  : 'border-[rgb(236_201_143_/_0.4)] text-warn-ink'
            }`}
          >
            {pick(language, `Streak ${data.streak.current}`, `Chuỗi ${data.streak.current} ngày`)}
          </span>
          {!compact && (
            <button type="button" className={BUTTON_SECONDARY} onClick={editing ? () => setEditing(false) : beginEdit}>
              {editing ? pick(language, 'Close', 'Đóng') : pick(language, 'Edit goals', 'Sửa mục tiêu')}
            </button>
          )}
          {compact && (
            <button type="button" className={BUTTON_GHOST} onClick={editing ? () => setEditing(false) : beginEdit}>
              {pick(language, 'Edit', 'Sửa')}
            </button>
          )}
        </div>
      </div>

      {risk !== null && <StreakWarning data={data} risk={risk} language={language} />}

      {!data.chosen && (
        <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-muted">
          {pick(
            language,
            'These are suggested goals. Choose your own whenever you are ready.',
            'Đây là mục tiêu gợi ý. Bạn có thể chọn mục tiêu của mình bất cứ lúc nào.',
          )}
        </p>
      )}

      <div className="mt-4 grid grid-cols-3 gap-4 sm:gap-6">
        <GoalRing
          label={pick(language, 'New words', 'Từ mới')}
          part={data.newWords}
          language={language}
          tone="new"
        />
        <GoalRing
          label={pick(language, 'Reviews', 'Lượt ôn')}
          part={data.reviews}
          language={language}
          tone="review"
        />
        <GoalRing
          label={pick(language, 'Practice', 'Thực hành')}
          part={data.practice}
          language={language}
          tone="new"
        />
      </div>

      {editing && (
        <div className="mt-4 flex flex-col gap-3 border-t border-line/80 pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              {pick(language, 'New words a day', 'Từ mới mỗi ngày')}
              <input
                type="number"
                min={0}
                max={1000}
                inputMode="numeric"
                className={INPUT}
                value={maintenance ? '0' : newWords}
                disabled={maintenance}
                onChange={(event) => setNewWords(event.target.value)}
              />
            </label>
            <div className="flex flex-col gap-1 text-xs font-medium text-muted">
              <span>{pick(language, 'Reviews', 'Lượt ôn')}</span>
              <p className="text-xs leading-relaxed text-faint">
                {pick(
                  language,
                  'Everything due today, so there is no number to set. Met once nothing is left to study.',
                  'Mọi từ đến hạn hôm nay, nên không cần đặt số. Đạt khi không còn gì để học.',
                )}
              </p>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              {pick(language, 'Practice questions', 'Câu thực hành')}
              <input
                type="number"
                min={0}
                max={1000}
                inputMode="numeric"
                className={INPUT}
                value={practice}
                onChange={(event) => setPractice(event.target.value)}
              />
            </label>
          </div>
          <label className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={maintenance}
              onChange={(event) => setMaintenance(event.target.checked)}
            />
            <span>
              {pick(
                language,
                'Maintenance mode: no new words, only reviews. Use this when there is nothing left to add.',
                'Chế độ duy trì: không thêm từ mới, chỉ ôn lại. Dùng khi không còn từ nào để thêm.',
              )}
            </span>
          </label>
          {error !== null && (
            <p role="alert" className="text-xs text-bad-ink">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className={BUTTON_PRIMARY} disabled={saving} onClick={() => void save()}>
              {saving ? pick(language, 'Saving…', 'Đang lưu…') : pick(language, 'Save goals', 'Lưu mục tiêu')}
            </button>
            <button type="button" className={BUTTON_SECONDARY} disabled={saving} onClick={() => setEditing(false)}>
              {pick(language, 'Cancel', 'Hủy')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
