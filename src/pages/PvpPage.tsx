/**
 * Word duels (docs/gamification-plan.md, phase 5): the lobby, the match and
 * its result. The server referees: this page shows what it is told, sends the
 * option chosen, and asks about once a second how the match stands.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PvpLobby, PvpMatch } from '../../shared/api.js';
import { PVP } from '../../shared/pvp.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { TierBadge } from '../components/League.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { fetchGameShared } from '../lib/game-state.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES, buildHref, navigate, useLocation } from '../lib/router.js';

const errorText = (cause: unknown, language: UiLanguage) =>
  cause instanceof ApiError ? cause.message : pick(language, 'That did not work.', 'Không thực hiện được.');

/** Calls `work` every `ms` while mounted, never two at once. */
function usePoll(work: () => Promise<void>, ms: number, enabled: boolean) {
  const busy = useRef(false);
  const latest = useRef(work);
  useEffect(() => {
    latest.current = work;
  });
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (busy.current) return;
      busy.current = true;
      latest.current().finally(() => {
        busy.current = false;
      });
    }, ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
}

// ---- The match ----

function HealthBar({ name, hp, mine, language }: { name: string | null; hp: number; mine: boolean; language: UiLanguage }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={`flex items-baseline justify-between gap-2 text-xs ${mine ? 'text-ink' : 'text-muted'}`}>
        <span className="truncate font-semibold">{mine ? pick(language, 'You', 'Bạn') : (name ?? pick(language, 'Opponent', 'Đối thủ'))}</span>
        <span className="shrink-0 tabular-nums">{hp}</span>
      </span>
      <span className="block h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={PVP.hp} aria-valuenow={hp} aria-label={mine ? pick(language, 'Your health', 'Máu của bạn') : pick(language, 'Opponent’s health', 'Máu đối thủ')}>
        <span
          className={`block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${mine ? 'bg-good' : 'bg-bad'}`}
          style={{ width: `${(hp / PVP.hp) * 100}%` }}
        />
      </span>
    </div>
  );
}

function Result({ match, language, onAgain }: { match: PvpMatch; language: UiLanguage; onAgain: () => void }) {
  const { vocabulary, toasts } = useApp();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const title =
    match.result === 'won'
      ? pick(language, 'You won', 'Bạn thắng')
      : match.result === 'draw'
        ? pick(language, 'A draw', 'Hòa')
        : pick(language, 'You lost', 'Bạn thua');
  const why =
    match.reason === 'left'
      ? match.result === 'won'
        ? pick(language, 'Your opponent left the match.', 'Đối thủ đã rời trận.')
        : pick(language, 'You left the match.', 'Bạn đã rời trận.')
      : match.reason === 'time'
        ? pick(language, 'Time is up: the most health left wins.', 'Hết giờ: ai còn nhiều máu hơn thắng.')
        : pick(language, 'Health ran out.', 'Hết máu.');
  const add = (word: { word: string; meaning: string }) => {
    vocabulary.create({ word: word.word, meaning: word.meaning });
    setAdded((current) => new Set([...current, word.word]));
    toasts.show({ message: pick(language, `Added: ${word.word}`, `Đã thêm: ${word.word}`) });
  };
  return (
    <div className="flex flex-col gap-4">
      <section className={`${CARD} pool pool-top flex flex-col items-center gap-3 p-6 text-center`}>
        <Icon name={match.result === 'won' ? 'trophy' : 'duel'} className={`size-12 ${match.result === 'won' ? 'text-[#f0c75e]' : 'text-muted'}`} />
        <h2 className="font-serif text-3xl font-semibold text-ink">{title}</h2>
        <p className={HELP}>{why}</p>
        <p className="text-sm tabular-nums text-muted">
          {match.me.hp} – {match.them.hp} · {pick(language, `${match.me.correct} right, ${match.me.wrong} wrong`, `${match.me.correct} đúng, ${match.me.wrong} sai`)}
        </p>
        {match.reward !== null && (
          <p className="flex flex-wrap justify-center gap-3 text-sm font-semibold text-ink">
            {match.reward.xp > 0 && <span>+{match.reward.xp} XP</span>}
            {match.reward.stardust > 0 && <span>+{match.reward.stardust} ✦</span>}
            {match.mode !== 'friend' && (
              <span className={match.reward.ratingTo >= match.reward.ratingFrom ? 'text-good-ink' : 'text-bad-ink'}>
                {match.reward.ratingFrom} → {match.reward.ratingTo}
              </span>
            )}
          </p>
        )}
        <p className={HELP}>{pick(language, 'Rewards wait on the Dashboard to be claimed.', 'Phần thưởng chờ nhận ở Dashboard.')}</p>
        <button type="button" className={BUTTON_PRIMARY} onClick={onAgain}>
          {pick(language, 'Back to duels', 'Về sảnh đấu')}
        </button>
      </section>
      {match.words.length > 0 && (
        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Words from this match', 'Từ trong trận này')}</h2>
          <ul className="flex flex-col divide-y divide-line">
            {match.words.map((word) => (
              <li key={word.word} className="flex items-center gap-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-serif text-[1.0625rem] font-medium text-ink">{word.word}</span>
                  <span className="truncate text-sm text-muted">{word.meaning}</span>
                </span>
                <button type="button" className={BUTTON_SECONDARY} disabled={added.has(word.word)} onClick={() => add(word)}>
                  {added.has(word.word) ? pick(language, 'Added', 'Đã thêm') : pick(language, 'Add to mine', 'Thêm vào sổ từ')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Match({ id, language }: { id: string; language: UiLanguage }) {
  const { api, toasts } = useApp();
  const [match, setMatch] = useState<PvpMatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<PvpMatch['last']>(null);
  /** The server's clock minus this device's, so the countdown agrees with the referee. */
  const [offset, setOffset] = useState(0);
  const [clock, setClock] = useState(() => Date.now());

  const adopt = useCallback((next: PvpMatch) => {
    setOffset(next.now - Date.now());
    setMatch(next);
    if (next.finished) void fetchGameShared(api).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    let current = true;
    api.pvpMatch(id).then(
      (next) => current && adopt(next),
      (cause: unknown) => current && setError(errorText(cause, language)),
    );
    return () => {
      current = false;
    };
  }, [api, id, adopt, language]);

  usePoll(
    async () => {
      try {
        adopt(await api.pvpMatch(id));
      } catch {
        // A missed heartbeat is retried on the next one.
      }
    },
    1000,
    match !== null && !match.finished,
  );

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const choose = useCallback(
    async (choice: number) => {
      if (match === null || match.question === null || sending) return;
      setSending(true);
      try {
        const next = await api.pvpAnswer(id, match.question.index, choice);
        if (next.last !== null) {
          setFlash(next.last);
          setTimeout(() => setFlash(null), next.last.correct ? 450 : 900);
        }
        adopt(next);
      } catch (cause) {
        toasts.show({ message: errorText(cause, language) });
      } finally {
        setSending(false);
      }
    },
    [api, id, match, sending, adopt, toasts, language],
  );

  // Keys 1 to 4 answer, as the options are numbered.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const index = ['1', '2', '3', '4'].indexOf(event.key);
      if (index >= 0 && !event.repeat) void choose(index);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choose]);

  if (error !== null) return <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">{error}</p>;
  if (match === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> {pick(language, 'Loading the match…', 'Đang tải trận đấu…')}
      </p>
    );
  }
  if (match.finished) return <Result match={match} language={language} onAgain={() => navigate(ROUTES.pvp)} />;

  const serverNow = clock + offset;
  const left = Math.max(0, Math.ceil((match.endsAt - serverNow) / 1000));
  const locked = match.me.lockedUntil > serverNow;
  const lockLeft = Math.ceil((match.me.lockedUntil - serverNow) / 1000);
  const forfeit = async () => {
    try {
      adopt(await api.pvpForfeit(id));
    } catch (cause) {
      toasts.show({ message: errorText(cause, language) });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <section className={`${CARD} flex flex-col gap-3 p-4`}>
        <div className="flex items-center gap-4">
          <HealthBar name={match.me.nickname} hp={match.me.hp} mine language={language} />
          <span className={`shrink-0 font-serif text-2xl font-semibold tabular-nums ${left <= 15 ? 'text-bad-ink' : 'text-ink'}`} aria-label={pick(language, `${left} seconds left`, `Còn ${left} giây`)}>
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </span>
          <HealthBar name={match.them.nickname} hp={match.them.hp} mine={false} language={language} />
        </div>
      </section>

      {match.question === null ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{pick(language, 'No more questions: waiting for the end.', 'Hết câu hỏi: đang chờ kết thúc.')}</p>
      ) : (
        <section className={`${CARD} relative flex flex-col gap-4 p-5`} aria-live="polite">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-faint">
            {match.question.direction === 'en-vi' ? pick(language, 'What does it mean?', 'Nghĩa là gì?') : pick(language, 'Which English word?', 'Từ tiếng Anh nào?')}
          </span>
          <h2 className="break-words font-serif text-3xl font-semibold text-ink">{match.question.prompt}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {match.question.options.map((option, at) => (
              <button
                key={`${match.question!.index}:${at}`}
                type="button"
                disabled={sending || locked}
                onClick={() => void choose(at)}
                className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left text-[0.9375rem] font-medium text-ink transition-colors hover:border-accent/60 active:bg-accent-soft disabled:opacity-50"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-xs text-faint max-sm:hidden">{at + 1}</span>
                <span className="min-w-0 break-words">{option}</span>
              </button>
            ))}
          </div>
          {locked && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-2xl bg-paper/85 text-center">
              <span className="font-serif text-4xl font-semibold tabular-nums text-bad-ink">{lockLeft}</span>
              <span className="text-sm text-muted">{pick(language, 'Wrong: locked for a moment', 'Sai: bị khóa một lúc')}</span>
            </div>
          )}
        </section>
      )}
      {flash !== null && (
        <p role="status" className={`text-center text-sm font-semibold ${flash.correct ? 'text-good-ink' : 'text-bad-ink'}`}>
          {flash.correct
            ? flash.crit
              ? pick(language, `Critical! −${flash.damage}`, `Chí mạng! −${flash.damage}`)
              : pick(language, `Right! −${flash.damage}`, `Đúng! −${flash.damage}`)
            : pick(language, 'Wrong', 'Sai')}
        </p>
      )}
      <button type="button" className={`${BUTTON_GHOST} self-center`} onClick={() => void forfeit()}>
        {pick(language, 'Give up', 'Bỏ cuộc')}
      </button>
    </div>
  );
}

// ---- The lobby ----

function Lobby({ data, language, reload }: { data: PvpLobby; language: UiLanguage; reload: () => void }) {
  const { api, toasts } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const friends = useRemote(api.fetchFriends, 'Could not load your friends.');
  const waiting = data.waiting;
  const [clock, setClock] = useState(() => Date.now());

  usePoll(
    async () => {
      setClock(Date.now());
      try {
        const tick = await api.pvpTick();
        if (tick.state === 'match' && tick.matchId !== null) navigate(buildHref(ROUTES.pvp, { m: tick.matchId }));
        else if (tick.state === 'idle') reload();
      } catch {
        // Tried again on the next tick.
      }
    },
    1000,
    waiting !== null,
  );

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      const result = await work();
      if (typeof result === 'object' && result !== null && 'matchId' in result && typeof result.matchId === 'string') {
        navigate(buildHref(ROUTES.pvp, { m: result.matchId }));
        return;
      }
      reload();
    } catch (cause) {
      toasts.show({ message: errorText(cause, language) });
    } finally {
      setBusy(null);
    }
  };

  const locked = data.lockedUntil !== null;
  const mutual = friends.status === 'ready' ? friends.data.friends.filter((friend) => friend.mutual) : [];
  return (
    <div className="flex flex-col gap-5">
      <section className={`${CARD} pool pool-top flex items-center gap-4 p-5`}>
        <span className="flex size-16 shrink-0 flex-col items-center justify-center rounded-full border-2 border-accent/60">
          <span className="font-serif text-xl font-semibold tabular-nums leading-none text-ink">{data.rating}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <TierBadge tier={data.tier} className="self-start" />
          <span className={HELP}>
            {pick(language, `Season ${data.season} · ${data.record.wins} won, ${data.record.draws} drawn, ${data.record.losses} lost`, `Mùa ${data.season} · thắng ${data.record.wins}, hòa ${data.record.draws}, thua ${data.record.losses}`)}
          </span>
        </span>
      </section>

      {data.matchId !== null && (
        <button type="button" className={BUTTON_PRIMARY} onClick={() => navigate(buildHref(ROUTES.pvp, { m: data.matchId! }))}>
          {pick(language, 'Back to your match', 'Quay lại trận đang đấu')}
        </button>
      )}

      {data.invites.map((invite) => (
        <section key={invite.nickname} className={`${CARD} flex items-center gap-3 border-accent/40 p-4`}>
          <Icon name="duel" className="size-5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-sm text-ink">{pick(language, `${invite.nickname} wants a duel`, `${invite.nickname} mời bạn đấu`)}</span>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy !== null} onClick={() => void act('accept', () => api.pvpAccept(invite.nickname))}>
            {pick(language, 'Accept', 'Nhận lời')}
          </button>
        </section>
      ))}

      {!data.consented ? (
        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Before your first duel', 'Trước trận đầu tiên')}</h2>
          <p className="text-sm text-muted">
            {pick(
              language,
              'Each duel is made of words from both players: your opponent will see some of your words and their meanings. Nothing else of yours is shown.',
              'Mỗi trận gồm từ của cả hai người: đối thủ sẽ thấy một số từ của bạn và nghĩa của chúng. Không có gì khác của bạn được hiện ra.',
            )}
          </p>
          <button type="button" className={`${BUTTON_PRIMARY} self-start`} disabled={busy !== null} onClick={() => void act('consent', () => api.pvpConsent())}>
            {pick(language, 'I understand', 'Tôi hiểu')}
          </button>
        </section>
      ) : waiting !== null ? (
        <section className={`${CARD} flex flex-col items-center gap-3 p-6 text-center`}>
          <Spinner />
          <p className="text-sm text-ink">
            {waiting.mode === 'friend'
              ? pick(language, 'Waiting for your friend to accept…', 'Đang chờ bạn bè nhận lời…')
              : pick(language, 'Looking for an opponent…', 'Đang tìm đối thủ…')}
          </p>
          <p className={`${HELP} tabular-nums`}>{Math.max(0, Math.floor((clock - Date.parse(waiting.since)) / 1000))}s</p>
          <button type="button" className={BUTTON_GHOST} onClick={() => void act('leave', () => api.pvpLeave())}>
            {pick(language, 'Cancel', 'Hủy')}
          </button>
        </section>
      ) : (
        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Ranked duel', 'Đấu xếp hạng')}</h2>
          <p className={HELP}>
            {pick(
              language,
              'Two minutes, same questions, each at your own pace. A right answer takes 10 health from your opponent, 15 within three seconds; a wrong one locks you for three seconds.',
              'Hai phút, cùng bộ câu hỏi, mỗi người theo tốc độ riêng. Đúng trừ đối thủ 10 máu, 15 nếu trả lời trong 3 giây; sai bị khóa 3 giây.',
            )}
          </p>
          {locked && (
            <p className="text-sm text-warn-ink">
              {pick(language, 'Leaving matches has locked matchmaking for a few minutes.', 'Bỏ trận nhiều lần nên tạm khóa ghép trận vài phút.')}
            </p>
          )}
          <button type="button" className={`${BUTTON_PRIMARY} self-start`} disabled={busy !== null || locked} onClick={() => void act('queue', () => api.pvpQueue())}>
            {busy === 'queue' ? <Spinner /> : <Icon name="duel" className="size-4" />}
            {pick(language, 'Find an opponent', 'Tìm đối thủ')}
          </button>
        </section>
      )}

      {data.consented && waiting === null && mutual.length > 0 && (
        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'Duel a friend', 'Đấu với bạn bè')}</h2>
          <p className={HELP}>{pick(language, 'Not rated; XP as usual. They have a minute to accept.', 'Không tính hạng; vẫn có XP. Bạn bè có một phút để nhận lời.')}</p>
          <ul className="flex flex-col gap-1">
            {mutual.map((friend) => (
              <li key={friend.nickname} className="flex items-center gap-3 py-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{friend.nickname}</span>
                <button type="button" className={BUTTON_SECONDARY} disabled={busy !== null || locked} onClick={() => void act(`invite:${friend.nickname}`, () => api.pvpInvite(friend.nickname))}>
                  {pick(language, 'Duel', 'Mời đấu')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(data.headToHead.length > 0 || data.recent.length > 0) && (
        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>{pick(language, 'History', 'Lịch sử')}</h2>
          {data.headToHead.map((row) => (
            <p key={row.nickname} className="text-sm text-ink">
              {pick(language, 'You', 'Bạn')} <span className="font-semibold tabular-nums">{row.wins} – {row.losses}</span> {row.nickname}
              {row.draws > 0 && <span className="text-faint"> · {pick(language, `${row.draws} drawn`, `hòa ${row.draws}`)}</span>}
            </p>
          ))}
          <ul className="flex flex-col divide-y divide-line">
            {data.recent.map((match) => (
              <li key={match.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate text-ink">{match.opponent ?? pick(language, 'A player', 'Một người chơi')}</span>
                <span className={match.result === 'won' ? 'font-semibold text-good-ink' : match.result === 'lost' ? 'text-bad-ink' : 'text-muted'}>
                  {match.result === 'won' ? pick(language, 'Won', 'Thắng') : match.result === 'lost' ? pick(language, 'Lost', 'Thua') : pick(language, 'Draw', 'Hòa')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function PvpPage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const { query } = useLocation();
  const matchId = query.get('m');
  const lobby = useRemote(api.fetchPvp, 'Could not load duels.');
  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      {matchId === null && (
        <PageHeader
          title={pick(language, 'Word duels', 'Đấu từ vựng')}
          description={pick(language, 'Race another player through the same words. Ranked by season.', 'Đua với người khác qua cùng một bộ từ. Xếp hạng theo mùa.')}
        />
      )}
      {matchId !== null ? (
        <Match key={matchId} id={matchId} language={language} />
      ) : lobby.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : lobby.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {lobby.error}
        </p>
      ) : !lobby.data.available ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{lobby.data.reason}</p>
      ) : (
        <Lobby data={lobby.data} language={language} reload={lobby.reload} />
      )}
    </div>
  );
}
