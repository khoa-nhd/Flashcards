/**
 * Moderation (docs/gamification-plan.md, 2.6): reports waiting for an admin.
 * The server shows it only to an account on ADMIN_EMAILS that the database's
 * own list of admins also names; the page itself decides nothing.
 */
import { useState } from 'react';
import type { AdminReport } from '../../shared/api.js';
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
