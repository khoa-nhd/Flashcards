/**
 * A player's public profile (docs/gamification-plan.md, 2.5): nickname, level,
 * league, streak, badges and words at Master. Never a word list. One's own
 * profile can be turned into an image to share; another's can be followed,
 * blocked or reported.
 */
import { useCallback, useState } from 'react';
import type { ProfileResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { TierBadge } from '../components/League.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import {
  BUTTON_DANGER,
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  CARD,
  HELP,
  INPUT,
  LABEL,
  PAGE,
  SECTION_TITLE,
} from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { badgeName, leagueName, tierName } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES, useLocation } from '../lib/router.js';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-xl border border-line px-3 py-3 text-center">
      <span className="font-serif text-2xl font-semibold tabular-nums text-ink">{value}</span>
      <span className="text-[0.6875rem] font-medium uppercase tracking-wider text-faint">{label}</span>
    </div>
  );
}

/** Draws the profile as a square image, in the app's night colours. */
async function achievementImage(profile: ProfileResponse, language: UiLanguage): Promise<Blob> {
  const size = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('No canvas');
  const sky = context.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, '#141b33');
  sky.addColorStop(1, '#2c2350');
  context.fillStyle = sky;
  context.fillRect(0, 0, size, size);
  // A scatter of stars, the same every time.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  context.fillStyle = 'rgba(255, 255, 255, 0.7)';
  for (let at = 0; at < 90; at += 1) {
    context.beginPath();
    context.arc(random() * size, random() * size * 0.6, random() * 2.2 + 0.4, 0, Math.PI * 2);
    context.fill();
  }
  // The moon.
  context.fillStyle = '#f3e6b4';
  context.beginPath();
  context.arc(size - 190, 190, 90, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#1c2140';
  context.beginPath();
  context.arc(size - 155, 165, 80, 0, Math.PI * 2);
  context.fill();

  context.textAlign = 'center';
  context.fillStyle = '#ffffff';
  context.font = '600 84px "Source Serif 4", Georgia, serif';
  context.fillText(profile.nickname, size / 2, 430);
  context.font = '500 40px "Public Sans", system-ui, sans-serif';
  context.fillStyle = '#c9c4ea';
  context.fillText(`Level ${profile.level} · ${leagueName(language, profile.tier)}`, size / 2, 500);

  const stats: Array<[string, string]> = [
    [String(profile.streak), pick(language, 'day streak', 'ngày liên tiếp')],
    [String(profile.mastered), pick(language, 'at Master', 'từ Master')],
    [String(profile.badges.length), pick(language, 'badges', 'huy hiệu')],
  ];
  stats.forEach(([value, label], at) => {
    const x = size / 2 + (at - 1) * 300;
    context.fillStyle = '#ffffff';
    context.font = '600 96px "Source Serif 4", Georgia, serif';
    context.fillText(value, x, 720);
    context.fillStyle = '#c9c4ea';
    context.font = '500 34px "Public Sans", system-ui, sans-serif';
    context.fillText(label, x, 775);
  });
  context.fillStyle = 'rgba(255, 255, 255, 0.55)';
  context.font = '500 30px "Public Sans", system-ui, sans-serif';
  context.fillText(window.location.host, size / 2, size - 70);

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob === null ? reject(new Error('No image')) : resolve(blob)), 'image/png'),
  );
}

function ShareImage({ profile, language }: { profile: ProfileResponse; language: UiLanguage }) {
  const { toasts } = useApp();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const blob = await achievementImage(profile, language);
      const file = new File([blob], 'achievements.png', { type: 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: profile.nickname });
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'achievements.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (cause) {
      // Closing the share sheet is not a failure.
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        toasts.show({
          message: pick(language, 'Could not make the image.', 'Không tạo được ảnh.'),
        });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void make()}>
      {busy ? <Spinner /> : <Icon name="share" className="size-4" />}
      {pick(language, 'Make an achievement image', 'Tạo ảnh thành tích')}
    </button>
  );
}

function Report({ nickname, language, onClose }: { nickname: string; language: UiLanguage; onClose: () => void }) {
  const { api, toasts } = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.reportPlayer(nickname, reason);
      toasts.show({
        message: pick(language, 'Thanks. An admin will look at it.', 'Cảm ơn. Quản trị viên sẽ xem xét.'),
      });
      onClose();
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'Could not send the report.', 'Không gửi được báo cáo.'),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`${CARD} flex flex-col gap-3 p-5`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className={LABEL} htmlFor="report-reason">
        {pick(language, `What is wrong with ${nickname}?`, `${nickname} có vấn đề gì?`)}
      </label>
      <textarea
        id="report-reason"
        value={reason}
        maxLength={300}
        rows={3}
        onChange={(event) => setReason(event.target.value)}
        className={INPUT}
        placeholder={pick(language, 'A rude nickname, say', 'Ví dụ: biệt danh thô tục')}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON_GHOST} onClick={onClose}>
          {pick(language, 'Cancel', 'Hủy')}
        </button>
        <button type="submit" className={BUTTON_DANGER} disabled={busy || reason.trim() === ''}>
          {busy && <Spinner />}
          {pick(language, 'Send report', 'Gửi báo cáo')}
        </button>
      </div>
    </form>
  );
}

function Actions({ profile, language, reload }: { profile: ProfileResponse; language: UiLanguage; reload: () => void }) {
  const { api, toasts } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const act = async (action: 'follow' | 'unfollow' | 'block' | 'unblock', done: string) => {
    setBusy(action);
    try {
      await api.friendAction(action, profile.nickname);
      toasts.show({ message: done });
      reload();
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'That did not work.', 'Không thực hiện được.'),
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {!profile.blocked &&
          (profile.following ? (
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={busy !== null}
              onClick={() => void act('unfollow', pick(language, 'Unfollowed.', 'Đã bỏ theo dõi.'))}
            >
              {busy === 'unfollow' && <Spinner />}
              {pick(language, 'Following', 'Đang theo dõi')}
            </button>
          ) : (
            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={busy !== null}
              onClick={() => void act('follow', pick(language, `Following ${profile.nickname}.`, `Đã theo dõi ${profile.nickname}.`))}
            >
              {busy === 'follow' && <Spinner />}
              {profile.followedBy ? pick(language, 'Follow back', 'Theo dõi lại') : pick(language, 'Follow', 'Theo dõi')}
            </button>
          ))}
        <button
          type="button"
          className={BUTTON_GHOST}
          disabled={busy !== null}
          onClick={() =>
            void (profile.blocked
              ? act('unblock', pick(language, 'Unblocked.', 'Đã bỏ chặn.'))
              : act(
                  'block',
                  pick(language, `${profile.nickname} can no longer find you.`, `${profile.nickname} sẽ không tìm thấy bạn nữa.`),
                ))
          }
        >
          {busy === 'block' || busy === 'unblock' ? <Spinner /> : null}
          {profile.blocked ? pick(language, 'Unblock', 'Bỏ chặn') : pick(language, 'Block', 'Chặn')}
        </button>
        <button type="button" className={BUTTON_GHOST} onClick={() => setReporting(true)}>
          <Icon name="flag" className="size-4" />
          {pick(language, 'Report', 'Báo cáo')}
        </button>
      </div>
      {profile.followedBy && !profile.following && (
        <p className={HELP}>
          {pick(language, 'Follows you. Follow back to be friends.', 'Đang theo dõi bạn. Theo dõi lại để thành bạn bè.')}
        </p>
      )}
      {reporting && <Report nickname={profile.nickname} language={language} onClose={() => setReporting(false)} />}
    </div>
  );
}

export function ProfilePage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const location = useLocation();
  const nickname = location.query.get('u');
  const load = useCallback(() => api.fetchProfile(nickname), [api, nickname]);
  const profile = useRemote(load, 'Could not load the profile.');

  const data = profile.status === 'ready' ? profile.data : null;
  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader title={pick(language, 'Profile', 'Hồ sơ')} />
      {profile.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : profile.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {profile.error}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <section className={`${CARD} pool pool-top flex flex-col items-center gap-4 p-6 text-center`}>
            <span className="flex size-20 items-center justify-center rounded-full border-2 border-accent/60 bg-paper/60 font-serif text-3xl font-semibold text-ink">
              {[...data!.nickname][0]?.toUpperCase()}
            </span>
            <div className="flex flex-col items-center gap-1.5">
              <h2 className="font-serif text-2xl font-semibold text-ink">{data!.nickname}</h2>
              <span className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted">
                Level {data!.level} <TierBadge tier={data!.tier} />
              </span>
            </div>
            <div className="grid w-full max-w-md grid-cols-3 gap-2">
              <Stat label={pick(language, 'Streak', 'Chuỗi ngày')} value={String(data!.streak)} />
              <Stat label={pick(language, 'At Master', 'Từ Master')} value={String(data!.mastered)} />
              <Stat label={pick(language, 'Badges', 'Huy hiệu')} value={String(data!.badges.length)} />
            </div>
            {data!.limited && !data!.me && (
              <p className={HELP}>
                {pick(
                  language,
                  'This player keeps the rest of their profile to themselves.',
                  'Người chơi này giữ phần còn lại của hồ sơ ở chế độ riêng tư.',
                )}
              </p>
            )}
            {data!.me ? (
              <div className="flex flex-wrap justify-center gap-2">
                <ShareImage profile={data!} language={language} />
                <Link to={ROUTES.settings} className={BUTTON_SECONDARY}>
                  {pick(language, 'Change nickname', 'Đổi biệt danh')}
                </Link>
                {data!.admin === true && (
                  <Link to={ROUTES.admin} className={BUTTON_GHOST}>
                    {pick(language, 'Moderation', 'Quản trị')}
                  </Link>
                )}
              </div>
            ) : (
              !data!.limited && <Actions profile={data!} language={language} reload={profile.reload} />
            )}
          </section>

          {data!.badges.length > 0 && (
            <section className={`${CARD} p-5`}>
              <h2 className={SECTION_TITLE}>{pick(language, 'Badges', 'Huy hiệu')}</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {data!.badges.map((badge) => (
                  <li
                    key={badge.badge}
                    className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink"
                  >
                    <Icon name="trophy" className="size-3.5 text-accent" />
                    {badgeName(language, badge.badge)} · {tierName(language, badge.tier)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
