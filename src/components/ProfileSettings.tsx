/**
 * The nickname others see, and whether to join leagues (docs/gamification-plan.md,
 * 2.1). Hidden where the server keeps no leagues.
 */
import { useCallback, useState } from 'react';
import { NICKNAME_MAX } from '../../shared/gamification/nickname.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { nicknameProblemText } from './League.js';
import { Link } from './Link.js';
import { Spinner } from './Spinner.js';
import { BUTTON_PRIMARY, CARD, HELP, INPUT, LABEL, SECTION_TITLE } from './ui.js';

export function ProfileSettings() {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const load = useCallback(() => api.fetchProfile(null), [api]);
  const profile = useRemote(load, 'Could not load your profile.');
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (profile.status !== 'ready') return null;
  const nickname = draft ?? profile.data.nickname;

  const save = async (update: { nickname?: string; inLeagues?: boolean }) => {
    setBusy(true);
    setProblem(null);
    try {
      profile.adopt(await api.saveProfile(update));
      setDraft(null);
      toasts.show({ message: pick(language, 'Saved.', 'Đã lưu.') });
    } catch (cause) {
      if (cause instanceof ApiError && cause.problem !== null) setProblem(nicknameProblemText(language, cause.problem));
      else
        toasts.show({
          message: cause instanceof ApiError ? cause.message : pick(language, 'Could not save.', 'Không lưu được.'),
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Profile and leagues', 'Hồ sơ và giải đấu')}</h2>
      <form
        className="flex flex-col gap-1.5 sm:max-w-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ nickname });
        }}
      >
        <label htmlFor="nickname" className={LABEL}>
          {pick(language, 'Nickname', 'Biệt danh')}
        </label>
        <div className="flex gap-2">
          <input
            id="nickname"
            className={`${INPUT} min-w-0 flex-1`}
            value={nickname}
            maxLength={NICKNAME_MAX + 10}
            aria-invalid={problem !== null}
            aria-describedby="nickname-help"
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
          />
          <button type="submit" className={BUTTON_PRIMARY} disabled={busy || nickname.trim() === profile.data.nickname}>
            {busy && <Spinner />}
            {pick(language, 'Save', 'Lưu')}
          </button>
        </div>
        <p
          id="nickname-help"
          className={problem === null ? HELP : 'text-xs font-medium text-bad-ink'}
          role={problem === null ? undefined : 'alert'}
        >
          {problem ??
            pick(
              language,
              'What other players see instead of your email: 3 to 20 letters, digits or spaces.',
              'Tên người khác thấy thay cho email: 3 đến 20 chữ, số hoặc khoảng trắng.',
            )}
        </p>
      </form>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
          checked={profile.data.inLeagues ?? true}
          disabled={busy}
          onChange={(event) => void save({ inLeagues: event.target.checked })}
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-ink">{pick(language, 'Join weekly leagues', 'Tham gia giải đấu tuần')}</span>
          <span className={HELP}>
            {pick(
              language,
              'Off: you join no new group. A week already started keeps your place.',
              'Tắt: bạn không vào nhóm mới. Tuần đang chạy vẫn giữ chỗ.',
            )}
          </span>
        </span>
      </label>
      <p className={HELP}>
        <Link to={ROUTES.profile} className="font-medium text-accent underline-offset-2 hover:underline">
          {pick(language, 'See your profile', 'Xem hồ sơ của bạn')}
        </Link>
      </p>
    </section>
  );
}
