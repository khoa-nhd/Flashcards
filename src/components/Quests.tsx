/**
 * Today's and this week's quests (docs/gamification-plan.md, 1.3), on the
 * dashboard and on the Achievements page.
 */
import type { GameQuestView } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { useGame } from '../lib/game-state.js';
import { questProgress, questText } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { Icon } from './Icon.js';
import { Link } from './Link.js';
import { CARD } from './ui.js';

export function ProgressBar({ share, tone = 'accent' }: { share: number; tone?: 'accent' | 'good' }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
      <span
        className={`block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${tone === 'good' ? 'bg-good' : 'bg-accent'}`}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }}
      />
    </span>
  );
}

export function QuestRow({ quest, language }: { quest: GameQuestView; language: UiLanguage }) {
  return (
    <li className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3 text-sm">
        <span className={`min-w-0 ${quest.completed ? 'text-muted line-through decoration-line-strong' : 'text-ink'}`}>
          {questText(language, quest)}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-faint">
          {quest.completed ? (
            <span className="inline-flex items-center gap-1 font-semibold text-good-ink">
              <Icon name="check" className="size-3.5" />
              {pick(language, 'Done', 'Xong')}
            </span>
          ) : (
            <>
              {questProgress(quest)} · +{quest.reward} XP
            </>
          )}
        </span>
      </span>
      <ProgressBar share={quest.target === 0 ? 1 : quest.progress / quest.target} tone={quest.completed ? 'good' : 'accent'} />
    </li>
  );
}

/** The dashboard's card: today's three quests and the week's one. Nothing while the game is off. */
export function QuestsCard() {
  const { api } = useApp();
  const language = useUiLanguage();
  const { data } = useGame(api);
  if (data === null || !data.available || data.quests.day.length === 0) return null;
  const done = data.quests.day.filter((quest) => quest.completed).length;
  return (
    <section aria-label={pick(language, 'Today’s quests', 'Nhiệm vụ hôm nay')} className={`${CARD} p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">
          {pick(language, 'Today’s quests', 'Nhiệm vụ hôm nay')}{' '}
          <span className="tabular-nums">
            · {done}/{data.quests.day.length}
          </span>
        </h2>
        <Link to={ROUTES.achievements} className="text-xs font-medium text-accent underline-offset-2 hover:underline">
          {pick(language, 'Achievements', 'Thành tích')}
        </Link>
      </div>
      <ul className="mt-4 flex flex-col gap-4">
        {data.quests.day.map((quest) => (
          <QuestRow key={quest.kind} quest={quest} language={language} />
        ))}
        {data.quests.week !== null && <QuestRow quest={data.quests.week} language={language} />}
      </ul>
      <p className="mt-3 text-xs text-muted">
        {pick(language, 'All three done: +50 XP more.', 'Xong cả ba: thêm 50 XP.')}
      </p>
    </section>
  );
}
