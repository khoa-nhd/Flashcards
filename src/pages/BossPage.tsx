/**
 * The weekly boss (docs/gamification-plan.md, 3.6): fifteen of the account's
 * weakest words, fought in practice. Each word remembered hurts it, each one
 * forgotten heals it a little; progress carries over through the week.
 * Practice never moves a word's schedule, so neither does the boss.
 */
import { useApp, useUiLanguage } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { BOSS_XP, STARDUST } from '../../shared/gamification/economy.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';

export function BossPage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const boss = useRemote(api.fetchBoss, 'Could not load the weekly boss.');
  const data = boss.status === 'ready' ? boss.data : null;
  const share = data === null ? 1 : data.hp / data.max;
  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader
        title={pick(language, 'Weekly boss', 'Boss tuần')}
        description={pick(
          language,
          'Your weakest words, as one foe. Practise them: each one remembered is a hit, each one forgotten heals it a little. Your schedule is not touched.',
          'Những từ bạn hay quên nhất gộp thành một con boss. Luyện tập chúng: mỗi từ nhớ là một đòn, mỗi từ quên giúp boss hồi một ít. Lịch ôn không bị đổi.',
        )}
      />
      {boss.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : boss.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {boss.error}
        </p>
      ) : !data!.available ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{data!.reason}</p>
      ) : (
        <div className="flex flex-col gap-5">
          <section className={`${CARD} pool pool-top flex flex-col items-center gap-4 p-6 text-center`}>
            <span
              className={`flex size-28 items-center justify-center rounded-full border-2 ${
                data!.won ? 'border-good/60 text-good-ink' : 'border-bad/50 text-bad-ink shadow-[0_0_60px_-10px_rgb(240_120_120_/_0.45)]'
              } bg-paper/60`}
              aria-hidden="true"
            >
              <Icon name={data!.won ? 'trophy' : 'sword'} className="size-12" />
            </span>
            <h2 className="font-serif text-2xl font-semibold text-ink">
              {data!.won ? pick(language, 'Beaten this week', 'Đã hạ gục tuần này') : pick(language, 'The forgetting', 'Kẻ gây quên')}
            </h2>
            <div className="w-full max-w-md">
              <div
                className="h-3 w-full overflow-hidden rounded-full bg-line"
                role="progressbar"
                aria-label={pick(language, 'Boss health', 'Máu của boss')}
                aria-valuemin={0}
                aria-valuemax={data!.max}
                aria-valuenow={Math.round(data!.hp)}
              >
                <span
                  className="block h-full rounded-full bg-bad transition-[width] duration-700 motion-reduce:transition-none"
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              </div>
              <p className={`${HELP} mt-2 tabular-nums`}>
                {pick(
                  language,
                  `${Math.ceil(data!.hp)} of ${data!.max} health · ${data!.correct} hits, ${data!.wrong} misses this week`,
                  `Máu ${Math.ceil(data!.hp)}/${data!.max} · ${data!.correct} đòn trúng, ${data!.wrong} lần trượt tuần này`,
                )}
              </p>
            </div>
            {!data!.won && (
              <Link to={`${ROUTES.practice}?source=boss`} className={BUTTON_PRIMARY}>
                <Icon name="sword" className="size-4" />
                {pick(language, 'Fight: practise its words', 'Chiến đấu: luyện các từ của nó')}
              </Link>
            )}
            <p className={HELP}>
              {pick(
                language,
                `Beating it: ${BOSS_XP} XP, ${STARDUST.boss} stardust and the boss badge.`,
                `Hạ gục: ${BOSS_XP} XP, ${STARDUST.boss} bụi sao và huy hiệu boss.`,
              )}
            </p>
          </section>
          <section className={`${CARD} p-5`}>
            <h2 className={SECTION_TITLE}>{pick(language, 'Made of these words', 'Gồm những từ này')}</h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {data!.words.map((word) => (
                <li key={word.id} className="rounded-full border border-line px-3 py-1 text-sm text-ink">
                  {word.word}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
