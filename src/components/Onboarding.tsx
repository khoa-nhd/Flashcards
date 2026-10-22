/**
 * A short first-run introduction for FSRS-only accounts. It is deliberately
 * three screens: what memory strength is, that it can fall, and that FSRS (not
 * the number) decides when a word comes back. It also offers the gentle
 * starting goals of 10 new words and 30 reviews a day.
 */
import { useEffect, useState } from 'react';
import { useApp, useUiLanguage, useVocabulary } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { Link } from './Link.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD } from './ui.js';
import { useStudyGoals } from './StudyGoals.js';

export const ONBOARDING_KEY = 'vocabulary-review:onboarding:v1';

function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) !== null;
  } catch {
    // A blocked localStorage should not trap someone in the introduction forever.
    return true;
  }
}

function rememberOnboarding(): void {
  try {
    window.localStorage.setItem(ONBOARDING_KEY, 'done');
  } catch {
    // Nothing to do: the dialog simply appears again next time.
  }
}

export function Onboarding() {
  const state = useVocabulary();
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return state.status === 'ready' && state.meta?.fsrsOnly === true && !hasSeenOnboarding();
  });

  useEffect(() => {
    if (state.status !== 'ready' || state.meta?.fsrsOnly !== true) return;
    if (!hasSeenOnboarding()) {
      queueMicrotask(() => setOpen(true));
    }
  }, [state.status, state.meta?.fsrsOnly]);

  if (!open) return null;
  return (
    <OnboardingFlow
      onDone={() => {
        rememberOnboarding();
        setOpen(false);
      }}
    />
  );
}

function OnboardingFlow({ onDone }: { onDone: () => void }) {
  const { api } = useApp();
  const language = useUiLanguage();
  const goals = useStudyGoals(true);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const last = step === 2;

  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      if (goals.data?.chosen !== true) {
        await api.saveStudyGoals({ newWords: 10, reviews: 30, maintenanceMode: false });
      }
      onDone();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : pick(language, 'Could not save the suggested goals.', 'Không thể lưu mục tiêu gợi ý.'),
      );
    } finally {
      setSaving(false);
    }
  };

  const screens = [
    {
      eyebrow: pick(language, 'Memory strength', 'Sức nhớ'),
      title: pick(language, 'A simple 1–10 scale.', 'Một thang đơn giản từ 1 đến 10.'),
      body: pick(
        language,
        'Memory strength is read from how durable the memory is. It helps you see which words are still fragile. It is a display only: FSRS is what decides when a word is due.',
        'Sức nhớ được đọc từ độ bền của ký ức. Nó giúp bạn thấy từ nào còn mong manh. Đây chỉ là thang hiển thị: FSRS mới là thứ quyết định ngày ôn.',
      ),
      visual: (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-paper px-6 py-8">
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-faint">
            {pick(language, 'Memory strength', 'Sức nhớ')}
          </span>
          <span className="font-serif text-3xl font-semibold text-ink">
            {pick(language, '6/10 · Strong', '6/10 · Strong')}
          </span>
          <div className="flex w-full max-w-xs gap-1" aria-hidden="true">
            {Array.from({ length: 10 }, (_, index) => (
              <span
                key={index}
                className={`h-2 flex-1 rounded-full ${index < 6 ? 'bg-accent' : 'bg-line-strong'}`}
              />
            ))}
          </div>
          <span className="text-xs text-muted">
            {pick(language, 'New · Learning · Familiar · Strong · Master', 'New · Learning · Familiar · Strong · Master')}
          </span>
        </div>
      ),
    },
    {
      eyebrow: pick(language, 'It can change', 'Có thể thay đổi'),
      title: pick(language, 'Strength can drop. That is normal.', 'Sức nhớ có thể giảm. Điều đó bình thường.'),
      body: pick(
        language,
        'Forgetting a word or leaving it alone for a long time can lower the number. You will only see a quiet “needs review” hint — no red badge, no score to protect. Answer honestly and FSRS will bring the word back sooner.',
        'Quên một từ hoặc lâu không ôn có thể làm chỉ số giảm. Bạn chỉ thấy một gợi ý nhẹ “cần ôn lại” — không có nhãn đỏ, không có điểm để phải giữ. Cứ trả lời thành thật, FSRS sẽ mang từ quay lại sớm hơn.',
      ),
      visual: (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-paper px-6 py-8">
          <span className="inline-flex items-center gap-2 rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-muted">
            <span aria-hidden="true">↓</span>
            {pick(language, 'needs review', 'cần ôn lại')}
          </span>
          <p className="max-w-xs text-center text-xs leading-relaxed text-muted">
            {pick(
              language,
              'No shame, no streak penalty. Just a word asking to be seen again.',
              'Không xấu hổ, không mất chuỗi. Chỉ là một từ đang muốn được gặp lại.',
            )}
          </p>
        </div>
      ),
    },
    {
      eyebrow: pick(language, 'Scheduling', 'Lịch ôn'),
      title: pick(language, 'FSRS decides the next date.', 'FSRS quyết định ngày ôn tiếp theo.'),
      body: pick(
        language,
        'Each answer — Remember or Not remember — updates the schedule. Words are never retired and there is no maximum interval. A fragile word returns soon; a durable one waits longer. You can always review more than your goal.',
        'Mỗi câu trả lời — Nhớ hoặc Không nhớ — cập nhật lịch. Từ không bao giờ tự nghỉ và không có khoảng cách tối đa. Từ mong manh quay lại sớm; từ bền sẽ chờ lâu hơn. Bạn luôn có thể ôn thêm ngoài mục tiêu.',
      ),
      visual: (
        <div className="grid gap-2 rounded-2xl border border-line bg-paper px-5 py-6 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{pick(language, 'Remember', 'Nhớ')}</span>
            <span className="font-medium text-ink">{pick(language, 'later', 'lâu hơn')}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{pick(language, 'Not remember', 'Không nhớ')}</span>
            <span className="font-medium text-ink">{pick(language, 'sooner', 'sớm hơn')}</span>
          </div>
          <p className="mt-2 border-t border-line pt-2 text-xs leading-relaxed text-muted">
            {pick(
              language,
              'Suggested start: 10 new words and 30 reviews a day. Both are editable, and a day still counts even if you do more.',
              'Gợi ý bắt đầu: 10 từ mới và 30 lượt ôn mỗi ngày. Cả hai đều sửa được, và làm thêm vẫn tính.',
            )}
          </p>
        </div>
      ),
    },
  ] as const;

  const screen = screens[step]!;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="fixed inset-0 z-[90] flex items-end justify-center bg-scrim p-3 sm:items-center sm:p-6"
    >
      <div className={`${CARD} flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-y-auto p-5 sm:p-7`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-label={pick(language, 'Step 1 of 3', 'Bước 1 trên 3')}>
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                aria-hidden="true"
                className={`h-1.5 rounded-full transition-all ${index === step ? 'w-6 bg-accent' : 'w-1.5 bg-line-strong'}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={ROUTES.help}
              onClick={onDone}
              className="cursor-pointer text-xs font-semibold text-accent hover:underline"
            >
              {pick(language, 'Help', 'Trợ giúp')}
            </Link>
            <button
              type="button"
              className={BUTTON_GHOST}
              onClick={onDone}
              aria-label={pick(language, 'Skip introduction', 'Bỏ qua giới thiệu')}
            >
              {pick(language, 'Skip', 'Bỏ qua')}
            </button>
          </div>
        </div>

        <p className="mt-6 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-faint">{screen.eyebrow}</p>
        <h2 id="onboarding-title" className="mt-2 font-serif text-[2rem] font-semibold leading-tight tracking-[-0.02em]">
          {screen.title}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">{screen.body}</p>
        <div className="mt-5">{screen.visual}</div>

        {last && (
          <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/40 px-3 py-2.5 text-sm">
            <p className="font-medium text-ink">
              {pick(language, 'Start with 10 new words + 30 reviews a day.', 'Bắt đầu với 10 từ mới + 30 lượt ôn mỗi ngày.')}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {goals.data?.chosen === true
                ? pick(language, 'Your current goals stay as they are.', 'Mục tiêu hiện tại của bạn được giữ nguyên.')
                : pick(language, 'You can change both later in Settings.', 'Bạn có thể sửa cả hai sau trong Cài đặt.')}
            </p>
          </div>
        )}

        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-bad-ink">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className={BUTTON_GHOST}
            disabled={step === 0 || saving}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
          >
            {pick(language, 'Back', 'Quay lại')}
          </button>
          <div className="flex flex-wrap gap-2">
            {last && error !== null && (
              <button type="button" className={BUTTON_SECONDARY} onClick={onDone}>
                {pick(language, 'Start anyway', 'Bắt đầu luôn')}
              </button>
            )}
            {last ? (
              <button type="button" className={BUTTON_PRIMARY} disabled={saving} onClick={() => void finish()}>
                {saving
                  ? pick(language, 'Saving…', 'Đang lưu…')
                  : pick(language, 'Start reviewing', 'Bắt đầu ôn')}
              </button>
            ) : (
              <button type="button" className={BUTTON_PRIMARY} onClick={() => setStep((current) => current + 1)}>
                {pick(language, 'Next', 'Tiếp')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
