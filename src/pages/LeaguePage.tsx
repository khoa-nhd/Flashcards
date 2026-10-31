/**
 * The weekly league (docs/gamification-plan.md, 2.2): twenty players of one
 * tier, ranked by this week's XP. The top five go up a league on Monday, the
 * bottom five go down.
 */
import { useEffect, useState } from 'react';
import type { LeagueResponse, LeagueRow } from '../../shared/api.js';
import { MOVING, TIERS } from '../../shared/gamification/league.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { standing, timeLeft } from '../components/League.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { leagueName } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';

/** Ticks once a minute, for the time left in the week. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Ladder({ tier, language }: { tier: number; language: UiLanguage }) {
  return (
    <ol className="flex gap-1" aria-label={pick(language, 'The eight leagues', 'Tám hạng giải đấu')}>
      {Array.from({ length: TIERS }, (_, at) => {
        const step = at + 1;
        return (
          <li
            key={step}
            title={leagueName(language, step)}
            aria-current={step === tier ? 'step' : undefined}
            className={`h-1.5 flex-1 rounded-full ${step < tier ? 'bg-accent/50' : step === tier ? 'bg-accent' : 'bg-line'}`}
          >
            <span className="sr-only">{leagueName(language, step)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Zone({ kind, language }: { kind: 'up' | 'down'; language: UiLanguage }) {
  return (
    <li
      aria-hidden="true"
      className={`flex items-center gap-2 px-3 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] ${
        kind === 'up' ? 'text-good-ink' : 'text-bad-ink'
      }`}
    >
      <span className={`h-px flex-1 ${kind === 'up' ? 'bg-good/40' : 'bg-bad/40'}`} />
      {kind === 'up'
        ? pick(language, 'Promotion zone above', 'Vùng lên hạng ở trên')
        : pick(language, 'Demotion zone below', 'Vùng xuống hạng ở dưới')}
      <span className={`h-px flex-1 ${kind === 'up' ? 'bg-good/40' : 'bg-bad/40'}`} />
    </li>
  );
}

function Row({ row, language }: { row: LeagueRow; language: UiLanguage }) {
  const name = row.nickname ?? pick(language, 'Hidden player', 'Người chơi ẩn');
  const medal = row.rank <= 3 ? ['text-[#f0c75e]', 'text-[#ccd4dc]', 'text-[#e6b285]'][row.rank - 1] : 'text-faint';
  const body = (
    <>
      <span className={`w-7 shrink-0 text-right font-semibold tabular-nums ${medal}`}>{row.rank}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate text-sm ${row.me ? 'font-semibold text-ink' : 'font-medium text-ink'}`}>
          {name}
          {row.me && <span className="ml-1.5 text-xs font-medium text-accent">{pick(language, '(you)', '(bạn)')}</span>}
        </span>
        <span className="text-[0.6875rem] text-faint">Level {row.level}</span>
      </span>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{row.xp.toLocaleString(language)} XP</span>
    </>
  );
  const tone = row.me
    ? 'bg-accent-soft ring-1 ring-accent/40'
    : row.zone === 'up'
      ? 'bg-good-soft/40'
      : row.zone === 'down'
        ? 'bg-bad-soft/40'
        : '';
  return (
    <li>
      {row.nickname === null ? (
        <div className={`flex items-center gap-3 rounded-xl px-3 py-2 ${tone}`}>{body}</div>
      ) : (
        <Link
          to={`${ROUTES.profile}?u=${encodeURIComponent(row.nickname)}`}
          aria-current={row.me ? 'true' : undefined}
          className={`flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-line/30 ${tone}`}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

function Board({ league, language }: { league: LeagueResponse; language: UiLanguage }) {
  const rows = league.group!.rows;
  const tier = league.group!.tier;
  const size = rows.length;
  return (
    <section className={`${CARD} p-2 sm:p-3`}>
      <ol className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <FragmentRow
            key={`${row.rank}:${row.nickname ?? ''}`}
            row={row}
            language={language}
            up={tier < TIERS && row.rank === MOVING + 1}
            down={tier > 1 && row.rank === size - MOVING + 1}
          />
        ))}
      </ol>
    </section>
  );
}

function FragmentRow({ row, language, up, down }: { row: LeagueRow; language: UiLanguage; up: boolean; down: boolean }) {
  return (
    <>
      {up && <Zone kind="up" language={language} />}
      {down && <Zone kind="down" language={language} />}
      <Row row={row} language={language} />
    </>
  );
}

export function LeaguePage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const league = useRemote(api.fetchLeague, 'Could not load the league.');
  const now = useMinute();

  const data = league.status === 'ready' ? league.data : null;
  const tier = data?.group?.tier ?? data?.tier ?? 1;
  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader
        title={pick(language, 'League', 'Giải đấu')}
        description={pick(
          language,
          'Twenty players, one week. The top five go up a league on Monday; the bottom five go down.',
          'Hai mươi người, một tuần. Năm người đầu lên hạng vào thứ Hai; năm người cuối xuống hạng.',
        )}
      />

      {league.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : league.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {league.error}
        </p>
      ) : !data!.available ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{data!.reason}</p>
      ) : (
        <div className="flex flex-col gap-5">
          <section className={`${CARD} pool pool-top flex flex-col gap-4 p-5`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="font-serif text-2xl font-semibold text-ink">{leagueName(language, tier)}</span>
                <span className={HELP}>
                  {standing(language, data!) ?? pick(language, 'Not in a group yet this week', 'Tuần này chưa vào nhóm')}
                </span>
              </div>
              <span className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs font-medium text-muted">
                <Icon name="clock" className="size-3.5" />
                {timeLeft(language, data!.endsAt, now)}
              </span>
            </div>
            <Ladder tier={tier} language={language} />
            <p className={`${HELP} tabular-nums`}>
              {pick(language, `${data!.weekXp.toLocaleString('en')} XP this week`, `${data!.weekXp.toLocaleString('vi')} XP tuần này`)}
              {data!.nickname !== null && (
                <>
                  {' · '}
                  <Link to={ROUTES.profile} className="font-medium text-accent underline-offset-2 hover:underline">
                    {data!.nickname}
                  </Link>
                </>
              )}
            </p>
          </section>

          {data!.group !== null ? (
            <Board league={data!} language={language} />
          ) : (
            <section className={`${CARD} flex flex-col items-start gap-3 p-5`}>
              <h2 className={SECTION_TITLE}>
                {data!.inLeagues
                  ? pick(language, 'Join this week’s league', 'Vào giải đấu tuần này')
                  : pick(language, 'Leagues are off', 'Bạn đang tắt giải đấu')}
              </h2>
              <p className="text-sm text-muted">
                {data!.inLeagues
                  ? pick(
                      language,
                      'Your first XP this week puts you in a group of twenty in your league.',
                      'XP đầu tiên trong tuần sẽ đưa bạn vào một nhóm hai mươi người cùng hạng.',
                    )
                  : pick(
                      language,
                      'Turn them back on in Settings to join next time you earn XP.',
                      'Bật lại trong Cài đặt để vào nhóm khi bạn kiếm XP.',
                    )}
              </p>
              <Link to={data!.inLeagues ? ROUTES.review : ROUTES.settings} className={BUTTON_PRIMARY}>
                {data!.inLeagues ? pick(language, 'Start reviewing', 'Bắt đầu ôn') : pick(language, 'Open Settings', 'Mở Cài đặt')}
              </Link>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
