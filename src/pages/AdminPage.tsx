/**
 * Moderation (docs/gamification-plan.md, 2.6): reports waiting for an admin.
 * The server shows it only to an account on ADMIN_EMAILS that the database's
 * own list of admins also names; the page itself decides nothing.
 */
import { useState } from 'react';
import type { AdminReport, GameEvents } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_GHOST, BUTTON_SECONDARY, CARD, HELP, PAGE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { pick, type UiLanguage } from '../lib/i18n.js';

type Action = 'rename' | 'hide' | 'unhide' | 'resolve';

function ReportRow({ report, language, onDone }: { report: AdminReport; language: UiLanguage; onDone: () => void }) {
  const { api, toasts } = useApp();
  const [busy, setBusy] = useState<Action | null>(null);
  const act = async (action: Action) => {
    setBusy(action);
    try {
      await api.moderate(report.target, action);
      toasts.show({ message: pick(language, 'Done.', 'Đã xử lý.') });
      onDone();
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'That did not work.', 'Không thực hiện được.'),
      });
    } finally {
      setBusy(null);
    }
  };
  const button = (action: Action, label: string, style = BUTTON_SECONDARY) => (
    <button type="button" className={style} disabled={busy !== null} onClick={() => void act(action)}>
      {busy === action && <Spinner />}
      {label}
    </button>
  );
  return (
    <li className={`${CARD} flex flex-col gap-3 p-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">
          {report.nickname}
          {report.hidden && <span className="ml-2 text-xs font-medium text-faint">{pick(language, '(hidden)', '(đang ẩn)')}</span>}
        </span>
        <span className={HELP}>
          {pick(language, `${report.reports} open ${report.reports === 1 ? 'report' : 'reports'}`, `${report.reports} báo cáo chưa xử lý`)}{' '}
          · {new Date(report.createdAt).toLocaleString(language)}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-muted">{report.reason}</p>
      <div className="flex flex-wrap gap-2">
        {button('rename', pick(language, 'Give a random nickname', 'Đổi sang tên ngẫu nhiên'))}
        {report.hidden
          ? button('unhide', pick(language, 'Show the profile again', 'Hiện lại hồ sơ'))
          : button('hide', pick(language, 'Hide the profile', 'Ẩn hồ sơ'))}
        {button('resolve', pick(language, 'Nothing wrong', 'Không vi phạm'), BUTTON_GHOST)}
      </div>
    </li>
  );
}

const EVENT_LABELS: Record<keyof GameEvents, [string, string]> = {
  goldenHour: ['Golden hour (double XP for an hour each evening)', 'Giờ vàng (x2 XP một giờ mỗi tối)'],
  sunday: ['Sunday (+50% XP all day)', 'Chủ nhật (+50% XP cả ngày)'],
  monthly: ['Monthly challenge', 'Thử thách tháng'],
  boss: ['Weekly boss', 'Boss tuần'],
};

/** Events on or off for everyone (phase 3). Hidden where the database keeps none. */
function Events({ language }: { language: UiLanguage }) {
  const { api, toasts } = useApp();
  const events = useRemote(api.fetchEvents, 'Could not load the events.');
  const [busy, setBusy] = useState(false);
  if (events.status !== 'ready') return null;
  const save = async (key: keyof GameEvents, enabled: boolean) => {
    setBusy(true);
    try {
      events.adopt(await api.saveEvents({ [key]: enabled }));
    } catch (cause) {
      toasts.show({ message: cause instanceof ApiError ? cause.message : pick(language, 'That did not work.', 'Không thực hiện được.') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${CARD} mb-5 flex flex-col gap-3 p-5`}>
      <h2 className="text-sm font-semibold text-ink">{pick(language, 'Events', 'Sự kiện')}</h2>
      {(Object.keys(EVENT_LABELS) as Array<keyof GameEvents>).map((key) => (
        <label key={key} className="flex items-center gap-3 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={events.data[key]} disabled={busy} onChange={(event) => void save(key, event.target.checked)} />
          {pick(language, ...EVENT_LABELS[key])}
        </label>
      ))}
    </section>
  );
}

export function AdminPage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const admin = useRemote(api.fetchAdmin, 'Could not load the reports.');
  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader
        title={pick(language, 'Moderation', 'Quản trị')}
        description={pick(
          language,
          'Reports about nicknames and profiles. Every action also closes the reports about that player.',
          'Báo cáo về biệt danh và hồ sơ. Mỗi thao tác cũng đóng các báo cáo về người đó.',
        )}
      />
      {admin.status === 'ready' && <Events language={language} />}
      {admin.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : admin.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {admin.error}
        </p>
      ) : admin.data.reports.length === 0 ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{pick(language, 'No reports are waiting.', 'Không có báo cáo nào đang chờ.')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {/* Several reports about one player are handled together, so each player appears once. */}
          {admin.data.reports
            .filter((report, at, all) => all.findIndex((each) => each.target === report.target) === at)
            .map((report) => (
              <ReportRow key={report.id} report={report} language={language} onDone={admin.reload} />
            ))}
        </ul>
      )}
    </div>
  );
}
