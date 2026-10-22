/**
 * The FSRS section of Settings. There is no scheduler choice here: FSRS is the
 * only one. What can be changed is how hard it aims to keep a word remembered,
 * the optional daily review cap, and the two goals that make a streak.
 */
import { useEffect, useState } from 'react';
import type { AccountSettings, SchedulerReport } from '../../shared/api.js';
import { useApp, useSettings, useUiLanguage } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { pick } from '../lib/i18n.js';
import { BUTTON_SECONDARY, CARD, HELP, INPUT, SECTION_TITLE } from './ui.js';
import { StudyGoalsCard, useStudyGoals } from './StudyGoals.js';
import { BarChart } from './BarChart.js';
import { formatDate } from './badges.js';

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof ApiError ? cause.message : fallback;

const STRENGTH_LEGEND = [
  { band: 'New', range: '< 1 day', vi: 'Chưa ôn lần nào' },
  { band: 'Learning', range: '1–6 days', vi: 'Vừa bắt đầu nhớ' },
  { band: 'Familiar', range: '7–29 days', vi: 'Nhớ qua vài tuần' },
  { band: 'Strong', range: '30–364 days', vi: 'Nhớ qua nhiều tháng' },
  { band: 'Master', range: '365+ days', vi: 'Bền dài hạn' },
] as const;

export function FsrsSettingsSection() {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const goals = useStudyGoals(true);
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [report, setReport] = useState<SchedulerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState(90);
  const [limit, setLimit] = useState('');
  const [savingRetention, setSavingRetention] = useState(false);
  const [savingLimit, setSavingLimit] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void Promise.allSettled([api.fetchSettings(), api.fetchScheduler()]).then(([settingsResult, reportResult]) => {
      if (!current) return;
      if (settingsResult.status === 'fulfilled') {
        const loaded = settingsResult.value;
        setAccount(loaded);
        setRetention(Math.round((loaded.fsrsRetention ?? 0.9) * 100));
        setLimit(loaded.maxReviewsPerDay === null ? '' : String(loaded.maxReviewsPerDay));
      } else {
        setError(messageOf(settingsResult.reason, 'Could not load the FSRS settings.'));
      }
      if (reportResult.status === 'fulfilled') setReport(reportResult.value);
    });
    return () => {
      current = false;
    };
  }, [api]);

  const saveRetention = async () => {
    if (savingRetention) return;
    const value = Math.min(97, Math.max(70, Math.round(retention)));
    setRetention(value);
    setSavingRetention(true);
    try {
      const saved = await api.saveSettings({ fsrsRetention: value / 100 });
      setAccount(saved);
      toasts.show({
        message: pick(language, `Target retention set to ${value}%.`, `Đã đặt tỉ lệ ghi nhớ mục tiêu ${value}%.`),
      });
    } catch (cause) {
      toasts.show({
        tone: 'error',
        message: messageOf(cause, pick(language, 'Could not save target retention.', 'Không thể lưu tỉ lệ ghi nhớ.')),
      });
    } finally {
      setSavingRetention(false);
    }
  };

  const saveLimit = async () => {
    if (savingLimit) return;
    setLimitError(null);
    const parsed = limit.trim() === '' ? null : Number(limit);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000)) {
      setLimitError(pick(language, 'Use a whole number from 1 to 1000, or leave it empty for no limit.', 'Dùng số nguyên từ 1 đến 1000, hoặc để trống nếu không giới hạn.'));
      return;
    }
    setSavingLimit(true);
    try {
      const saved = await api.saveSettings({ maxReviewsPerDay: parsed });
      setAccount(saved);
      setLimit(saved.maxReviewsPerDay === null ? '' : String(saved.maxReviewsPerDay));
      toasts.show({
        message:
          saved.maxReviewsPerDay === null
            ? pick(language, 'Daily review limit turned off.', 'Đã tắt giới hạn lượt ôn mỗi ngày.')
            : pick(language, `Daily review limit set to ${saved.maxReviewsPerDay}.`, `Đã đặt giới hạn ${saved.maxReviewsPerDay} lượt ôn mỗi ngày.`),
      });
    } catch (cause) {
      setLimitError(messageOf(cause, pick(language, 'Could not save the limit.', 'Không thể lưu giới hạn.')));
    } finally {
      setSavingLimit(false);
    }
  };

  const workload = report?.workload.slice(0, 14) ?? [];

  return (
    <>
      <section className={`${CARD} flex flex-col gap-4 p-5`} aria-label={pick(language, 'FSRS scheduling', 'Lịch ôn FSRS')}>
        <div>
          <h2 className={SECTION_TITLE}>{pick(language, 'FSRS scheduling', 'Lịch ôn FSRS')}</h2>
          <p className={`${HELP} mt-1`}>
            {pick(
              language,
              'FSRS is the only scheduler. It keeps scheduling every word for as long as you study; no word ever retires.',
              'FSRS là bộ lập lịch duy nhất. Mọi từ đều được lập lịch mãi, không từ nào tự nghỉ.',
            )}
          </p>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-bad-ink">
            {error}
          </p>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
          <dt className="text-muted">{pick(language, 'Engine', 'Bộ máy')}</dt>
          <dd className="m-0 tabular-nums">{report?.fsrs.engine ?? 'FSRS'}</dd>
          <dt className="text-muted">{pick(language, 'Database', 'Cơ sở dữ liệu')}</dt>
          <dd className="m-0 tabular-nums">
            {account?.database === null || account?.database === undefined
              ? pick(language, 'Version not reported', 'Không báo phiên bản')
              : `v${account.database.version} / ${account.database.latest}`}
          </dd>
          <dt className="text-muted">{pick(language, 'Answers', 'Câu trả lời')}</dt>
          <dd className="m-0">
            {pick(language, 'Remember = Good, Not remember = Again', 'Remember = Good, Not remember = Again')}
          </dd>
        </dl>

        {workload.length > 0 && (
          <div>
            <BarChart
              title={pick(language, 'Due over the next 14 days', 'Đến hạn trong 14 ngày tới')}
              unit={[pick(language, 'word', 'từ'), pick(language, 'words', 'từ')]}
              categoryLabel={pick(language, 'Day', 'Ngày')}
              data={workload.map((day, index) => ({
                key: day.date,
                tick: index % 3 === 0 ? formatDate(day.date, 'short') : '',
                label: formatDate(day.date),
                value: day.fsrs,
              }))}
            />
          </div>
        )}

        <details className="rounded-xl border border-line">
          <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium">
            {pick(language, 'Advanced', 'Nâng cao')}
          </summary>
          <div className="flex flex-col gap-4 border-t border-line p-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="retention" className="text-sm font-medium">
                {pick(language, 'Target retention', 'Tỉ lệ ghi nhớ mục tiêu')}
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="retention"
                  type="range"
                  min={70}
                  max={97}
                  step={1}
                  value={retention}
                  onChange={(event) => setRetention(Number(event.target.value))}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                />
                <span className="w-12 text-right text-sm font-semibold tabular-nums">{retention}%</span>
              </div>
              <p className={HELP}>
                {pick(
                  language,
                  'Higher means more frequent reviews. The default is 90%; changing it affects future intervals, not the strength scale.',
                  'Càng cao thì càng ôn thường xuyên. Mặc định là 90%; thay đổi chỉ ảnh hưởng khoảng cách ôn sau này, không đổi thang sức nhớ.',
                )}
              </p>
              <button
                type="button"
                className={`${BUTTON_SECONDARY} self-start`}
                disabled={savingRetention}
                onClick={() => void saveRetention()}
              >
                {savingRetention
                  ? pick(language, 'Saving…', 'Đang lưu…')
                  : pick(language, 'Save retention', 'Lưu tỉ lệ ghi nhớ')}
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="review-limit" className="text-sm font-medium">
                {pick(language, 'Maximum reviews a day', 'Số lượt ôn tối đa mỗi ngày')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="review-limit"
                  type="number"
                  min={1}
                  max={1000}
                  inputMode="numeric"
                  placeholder={pick(language, 'No limit', 'Không giới hạn')}
                  className={`${INPUT} max-w-36`}
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                />
                <button type="button" className={BUTTON_SECONDARY} disabled={savingLimit} onClick={() => void saveLimit()}>
                  {savingLimit ? pick(language, 'Saving…', 'Đang lưu…') : pick(language, 'Save limit', 'Lưu giới hạn')}
                </button>
              </div>
              <p className={HELP}>
                {pick(
                  language,
                  'Off by default, so everything due is offered. A cap shortens today’s queue only; goals never stop a session.',
                  'Mặc định tắt, nên mọi từ đến hạn đều được đưa ra. Giới hạn chỉ rút ngắn hàng đợi hôm nay; mục tiêu không làm dừng buổi ôn.',
                )}
              </p>
              {limitError !== null && (
                <p role="alert" className="text-xs text-bad-ink">
                  {limitError}
                </p>
              )}
            </div>
          </div>
        </details>
      </section>

      <section className={`${CARD} p-5`} aria-label={pick(language, 'Memory strength scale', 'Thang sức nhớ')}>
        <h2 className={SECTION_TITLE}>{pick(language, 'Memory strength', 'Sức nhớ')}</h2>
        <p className={`${HELP} mt-1`}>
          {pick(
            language,
            'A display scale derived from FSRS stability (how long a memory is expected to last). It never decides when a word is due.',
            'Thang hiển thị suy ra từ độ bền FSRS (thời gian ước tính một ký ức còn lại). Nó không quyết định ngày ôn.',
          )}
        </p>
        <ul className="mt-3 m-0 flex list-none flex-col divide-y divide-line p-0 text-sm">
          {STRENGTH_LEGEND.map((item) => (
            <li key={item.band} className="grid grid-cols-[7rem_1fr] gap-3 py-2 first:pt-0 last:pb-0">
              <span className="font-semibold text-ink">{item.band}</span>
              <span className="text-muted">
                {item.range} · {language === 'vi' ? item.vi : item.band === 'New' ? 'Never studied' : 'Expected durability'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {goals.status === 'ready' && goals.data !== null && (
        <StudyGoalsCard data={goals.data} onSaved={goals.adopt} />
      )}
      {goals.error !== null && (
        <p role="alert" className="text-sm text-bad-ink">
          {goals.error}
        </p>
      )}
    </>
  );
}

/** The interface language; word meanings stay in Vietnamese. */
export function LanguageSetting() {
  const { api, settings, toasts } = useApp();
  const settingsState = useSettings();
  const [saving, setSaving] = useState(false);

  const change = async (value: (typeof settingsState)['uiLanguage']) => {
    settings.update({ uiLanguage: value });
    setSaving(true);
    try {
      await api.saveSettings({ uiLanguage: value === 'auto' ? null : value });
    } catch (cause) {
      toasts.show({
        tone: 'error',
        message: messageOf(cause, 'The language preference was kept on this device only.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium sm:max-w-xs">
      Interface language
      <select
        className={INPUT}
        value={settingsState.uiLanguage}
        disabled={saving}
        onChange={(event) => void change(event.target.value as typeof settingsState.uiLanguage)}
      >
        <option value="auto">Browser language (Vietnamese fallback)</option>
        <option value="vi">Tiếng Việt</option>
        <option value="en">English</option>
      </select>
      <span className={HELP}>Word meanings and examples are never translated.</span>
    </label>
  );
}
