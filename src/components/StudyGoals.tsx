/**
 * The two FSRS daily goals: new words and due reviews. They drive the streak
 * and nothing else; a session never stops when a goal is met, and a goal that
 * cannot be reached because nothing is left is explained rather than punished.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StudyGoalsResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from './ui.js';

export interface StudyGoalsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: StudyGoalsResponse | null;
  error: string | null;
}

/** Loads the goals only where the server can keep them, and exposes a reload. */
export function useStudyGoals(enabled: boolean) {
  const { api } = useApp();
  const [state, setState] = useState<StudyGoalsState>({ status: 'idle', data: null, error: null });

  const reload = useCallback(async () => {
    if (!enabled) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }
    setState((current) => ({ ...current, status: current.data === null ? 'loading' : 'ready', error: null }));
    try {
      const data = await api.fetchStudyGoals();
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

  return { ...state, reload, adopt: (data: StudyGoalsResponse) => setState({ status: 'ready', data, error: null }) };
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
          {part.exhausted && !part.met
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
  const [reviews, setReviews] = useState(String(data.goals.reviews));
  const [maintenance, setMaintenance] = useState(data.goals.maintenanceMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const beginEdit = () => {
    setNewWords(String(data.goals.newWords));
    setReviews(String(data.goals.reviews));
    setMaintenance(data.goals.maintenanceMode);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const nextNew = maintenance ? 0 : Number(newWords);
    const nextReviews = Number(reviews);
    if (!Number.isInteger(nextNew) || nextNew < 0 || !Number.isInteger(nextReviews) || nextReviews < 1) {
      setError(
        pick(
          language,
          'New words must be 0 or more, and reviews at least 1.',
          'Số từ mới phải từ 0 trở lên, và số lần ôn ít nhất là 1.',
        ),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveStudyGoals({
        newWords: nextNew,
        reviews: nextReviews,
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
              ? pick(language, 'Both goals are met today.', 'Hôm nay đã đạt cả hai mục tiêu.')
              : pick(
                  language,
                  'A streak needs both goals. Reaching them never stops a session.',
                  'Chuỗi ngày cần cả hai mục tiêu. Đạt mục tiêu không làm dừng buổi ôn.',
                )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-line-strong px-3 py-1 text-xs font-semibold tabular-nums text-muted">
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

      {!data.chosen && (
        <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-muted">
          {pick(
            language,
            'These are suggested goals. Choose your own whenever you are ready.',
            'Đây là mục tiêu gợi ý. Bạn có thể chọn mục tiêu của mình bất cứ lúc nào.',
          )}
        </p>
      )}

      <div className="mt-4 flex items-start justify-center gap-8 sm:gap-12">
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
      </div>

      {editing && (
        <div className="mt-4 flex flex-col gap-3 border-t border-line/80 pt-4">
          <div className="grid grid-cols-2 gap-3">
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
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              {pick(language, 'Reviews a day', 'Lượt ôn mỗi ngày')}
              <input
                type="number"
                min={1}
                max={1000}
                inputMode="numeric"
                className={INPUT}
                value={reviews}
                onChange={(event) => setReviews(event.target.value)}
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
