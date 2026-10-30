/**
 * Friends (docs/gamification-plan.md, 2.4): follow players by nickname or an
 * invite link. Two players who follow each other are friends: they see each
 * other's streak, keep a streak together and can challenge each other for the
 * week. The list is ranked by this week's XP.
 */
import { useEffect, useState } from 'react';
import type { Challenge, Friend, FriendsResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { TierBadge, timeLeft } from '../components/League.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES, navigate, useLocation } from '../lib/router.js';

const profileLink = (nickname: string) => `${ROUTES.profile}?u=${encodeURIComponent(nickname)}`;

/** Accepting an invite someone sent: the link opens this page with its token. */
function InviteBanner({ token, onDone }: { token: string; onDone: () => void }) {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await api.acceptInvite(token);
      toasts.show({
        message: pick(language, 'You are friends now.', 'Hai bạn đã là bạn bè.'),
      });
      onDone();
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'That invite did not work.', 'Lời mời không dùng được.'),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${CARD} pool pool-top flex flex-wrap items-center justify-between gap-3 p-5`}>
      <div>
        <h2 className={SECTION_TITLE}>{pick(language, 'You were invited', 'Bạn được mời kết bạn')}</h2>
        <p className={`${HELP} mt-1`}>{pick(language, 'Accept to follow each other.', 'Chấp nhận để hai người theo dõi nhau.')}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className={BUTTON_SECONDARY} onClick={onDone}>
          {pick(language, 'Not now', 'Để sau')}
        </button>
        <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void accept()}>
          {busy && <Spinner />}
          {pick(language, 'Accept', 'Chấp nhận')}
        </button>
      </div>
    </section>
  );
}

function Invite({ language }: { language: UiLanguage }) {
  const { api, toasts } = useApp();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const invite = await api.createInvite();
      setLink(`${window.location.origin}${ROUTES.friends}?invite=${encodeURIComponent(invite.token)}`);
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'Could not make a link.', 'Không tạo được link.'),
      });
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      toasts.show({ message: pick(language, 'Link copied.', 'Đã chép link.') });
    } catch {
      toasts.show({
        message: pick(language, 'Copy the link by hand.', 'Hãy tự chép link.'),
      });
    }
  };
  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Invite a friend', 'Mời bạn bè')}</h2>
      <p className={HELP}>
        {pick(
          language,
          'Whoever opens the link and accepts follows you, and you them. It works for 30 days.',
          'Ai mở link và chấp nhận sẽ cùng theo dõi với bạn. Link dùng được 30 ngày.',
        )}
      </p>
      {link === null ? (
        <button type="button" className={`${BUTTON_SECONDARY} self-start`} disabled={busy} onClick={() => void make()}>
          {busy ? <Spinner /> : <Icon name="share" className="size-4" />}
          {pick(language, 'Make an invite link', 'Tạo link mời')}
        </button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={link}
            className={`${INPUT} min-w-0 flex-1`}
            aria-label={pick(language, 'Invite link', 'Link mời')}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className={BUTTON_PRIMARY} onClick={() => void copy()}>
            {pick(language, 'Copy', 'Chép')}
          </button>
        </div>
      )}
    </section>
  );
}

function Search({ language, onChanged }: { language: UiLanguage; onChanged: () => void }) {
  const { api, toasts } = useApp();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Array<{
    nickname: string;
    level: number;
    tier: number;
  }> | null>(null);
  const [following, setFollowing] = useState<string | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      api.searchPlayers(text).then(
        (result) => {
          if (current) setFound(result.players);
        },
        () => {
          if (current) setFound([]);
        },
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, query]);

  const follow = async (nickname: string) => {
    setFollowing(nickname);
    try {
      await api.friendAction('follow', nickname);
      toasts.show({
        message: pick(language, `Following ${nickname}.`, `Đã theo dõi ${nickname}.`),
      });
      setQuery('');
      setFound(null);
      onChanged();
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'Could not follow.', 'Không theo dõi được.'),
      });
    } finally {
      setFollowing(null);
    }
  };

  const shown = query.trim().length < 2 ? null : found;
  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Find players', 'Tìm người chơi')}</h2>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={pick(language, 'Nickname', 'Biệt danh')}
        aria-label={pick(language, 'Search by nickname', 'Tìm theo biệt danh')}
        className={INPUT}
      />
      {shown !== null &&
        (shown.length === 0 ? (
          <p className={HELP}>
            {pick(language, 'No player has a nickname starting with that.', 'Không có biệt danh nào bắt đầu như vậy.')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((player) => (
              <li key={player.nickname} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
                <Link
                  to={profileLink(player.nickname)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-ink hover:underline"
                >
                  <span className="truncate">{player.nickname}</span>
                  <span className="text-[0.6875rem] text-faint">Level {player.level}</span>
                </Link>
                <TierBadge tier={player.tier} />
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  disabled={following !== null}
                  onClick={() => void follow(player.nickname)}
                >
                  {following === player.nickname && <Spinner />}
                  {pick(language, 'Follow', 'Theo dõi')}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

function FriendRow({
  friend,
  rank,
  challenged,
  language,
  onChallenge,
}: {
  friend: Friend;
  rank: number;
  challenged: boolean;
  language: UiLanguage;
  onChallenge: (nickname: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-3 py-2">
      <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-faint">{rank}</span>
      <Link to={profileLink(friend.nickname)} className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-ink hover:underline">{friend.nickname}</span>
        <span className="text-[0.6875rem] text-faint">
          Level {friend.level}
          {friend.mutual
            ? ` · ${pick(language, `streak ${friend.streak ?? 0}`, `chuỗi ${friend.streak ?? 0}`)} · ${pick(language, `together ${friend.sharedStreak ?? 0}`, `cùng nhau ${friend.sharedStreak ?? 0}`)}`
            : ` · ${pick(language, 'not following you back', 'chưa theo dõi lại')}`}
        </span>
      </Link>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{friend.weekXp.toLocaleString(language)} XP</span>
      {friend.mutual && !challenged && (
        <button type="button" className={`${BUTTON_SECONDARY} shrink-0`} onClick={() => onChallenge(friend.nickname)}>
          {pick(language, 'Challenge', 'Thách đấu')}
        </button>
      )}
    </li>
  );
}

function ChallengeRow({ challenge, language, onAccept }: { challenge: Challenge; language: UiLanguage; onAccept: (id: string) => void }) {
  const other = challenge.nickname ?? pick(language, 'A player', 'Một người chơi');
  const status = challenge.settled
    ? challenge.result === 'won'
      ? pick(language, 'You won', 'Bạn thắng')
      : challenge.result === 'draw'
        ? pick(language, 'A draw', 'Hòa')
        : pick(language, 'You lost', 'Bạn thua')
    : !challenge.accepted
      ? challenge.mine
        ? pick(language, 'Waiting for them to accept', 'Đang chờ chấp nhận')
        : pick(language, 'Challenged you', 'Đã thách đấu bạn')
      : challenge.current
        ? challenge.myXp >= challenge.otherXp
          ? pick(language, 'You are ahead', 'Bạn đang dẫn')
          : pick(language, 'You are behind', 'Bạn đang thua')
        : pick(language, 'Being decided', 'Đang chốt kết quả');
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-ink">
          {pick(language, 'You', 'Bạn')} <span className="text-faint">vs</span> {other}
        </span>
        <span className="text-[0.6875rem] text-faint">{status}</span>
      </span>
      {challenge.accepted && (
        <span className="text-sm font-semibold tabular-nums text-ink">
          {challenge.myXp} <span className="text-faint">:</span> {challenge.otherXp}
        </span>
      )}
      {!challenge.accepted && !challenge.mine && challenge.current && (
        <button type="button" className={BUTTON_PRIMARY} onClick={() => onAccept(challenge.id)}>
          {pick(language, 'Accept', 'Nhận lời')}
        </button>
      )}
    </li>
  );
}

function Lists({ data, language, reload }: { data: FriendsResponse; language: UiLanguage; reload: () => void }) {
  const { api, toasts } = useApp();
  const act = async (work: () => Promise<void>, done: string) => {
    try {
      await work();
      toasts.show({ message: done });
      reload();
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'That did not work.', 'Không thực hiện được.'),
      });
    }
  };
  const current = data.challenges.filter((challenge) => challenge.current);
  const challenged = new Set(current.map((challenge) => challenge.nickname));
  // One's own week, ranked among the friends'.
  const ranked: Array<Friend | null> = [...data.friends, null].sort(
    (a, b) => (b?.weekXp ?? data.weekXp) - (a?.weekXp ?? data.weekXp) || (a === null ? -1 : b === null ? 1 : 0),
  );
  return (
    <>
      <section className={`${CARD} p-2 sm:p-3`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pb-2 pt-2">
          <h2 className={SECTION_TITLE}>{pick(language, 'This week among friends', 'Tuần này giữa bạn bè')}</h2>
          <span className={HELP}>{timeLeft(language, data.endsAt)}</span>
        </div>
        {data.friends.length === 0 ? (
          <p className="px-3 pb-3 text-sm text-muted">
            {pick(
              language,
              'Follow someone, or send an invite link, to see them here.',
              'Theo dõi ai đó, hoặc gửi link mời, để thấy họ ở đây.',
            )}
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {ranked.map((friend, at) =>
              friend === null ? (
                <li key="me" className="flex items-center gap-3 rounded-xl bg-accent-soft px-3 py-2 ring-1 ring-accent/40">
                  <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-faint">{at + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                    {data.nickname} <span className="text-xs font-medium text-accent">{pick(language, '(you)', '(bạn)')}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{data.weekXp.toLocaleString(language)} XP</span>
                </li>
              ) : (
                <FriendRow
                  key={friend.nickname}
                  friend={friend}
                  rank={at + 1}
                  challenged={challenged.has(friend.nickname)}
                  language={language}
                  onChallenge={(nickname) =>
                    void act(
                      () => api.friendAction('challenge', nickname),
                      pick(language, `Challenge sent to ${nickname}.`, `Đã gửi thách đấu tới ${nickname}.`),
                    )
                  }
                />
              ),
            )}
          </ol>
        )}
      </section>

      {data.challenges.length > 0 && (
        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Weekly challenges', 'Thách đấu tuần')}</h2>
          <p className={HELP}>
            {pick(
              language,
              'Most XP by Sunday night wins 100 XP; a draw gives each 50.',
              'Ai nhiều XP hơn đến hết Chủ nhật được 100 XP; hòa thì mỗi người 50.',
            )}
          </p>
          <ul className="flex flex-col gap-2">
            {data.challenges.map((challenge) => (
              <ChallengeRow
                key={challenge.id}
                challenge={challenge}
                language={language}
                onAccept={(id) => void act(() => api.acceptChallenge(id), pick(language, 'Challenge accepted.', 'Đã nhận lời thách đấu.'))}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function FriendsPage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const location = useLocation();
  const friends = useRemote(api.fetchFriends, 'Could not load your friends.');
  const invite = location.query.get('invite');

  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader
        title={pick(language, 'Friends', 'Bạn bè')}
        description={pick(
          language,
          'Follow each other to share streaks and challenge each other for the week.',
          'Theo dõi nhau để giữ chuỗi cùng nhau và thách đấu theo tuần.',
        )}
      />
      <div className="flex flex-col gap-5">
        {invite !== null && (
          <InviteBanner
            token={invite}
            onDone={() => {
              navigate(ROUTES.friends, { replace: true });
              friends.reload();
            }}
          />
        )}
        {friends.status === 'loading' ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
          </p>
        ) : friends.status === 'failed' ? (
          <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
            {friends.error}
          </p>
        ) : (
          <>
            <Lists data={friends.data} language={language} reload={friends.reload} />
            <Search language={language} onChanged={friends.reload} />
            <Invite language={language} />
          </>
        )}
      </div>
    </div>
  );
}
