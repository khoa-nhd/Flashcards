/**
 * What is boosting XP right now, on the Dashboard (docs/gamification-plan.md,
 * 3.7): the golden hour, Sunday, a bought boost, companions, this month's
 * challenge, and the way to the weekly boss. Hidden where the economy is not kept.
 */
import { useApp, useUiLanguage } from '../app-context.js';
import { useGame } from '../lib/game-state.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { PetArt } from './Collectibles.js';
import { Icon } from './Icon.js';
import { Link } from './Link.js';
import { ProgressBar } from './Quests.js';
import { CARD, HELP, SECTION_TITLE } from './ui.js';

export function EventsCard() {
  const { api } = useApp();
  const language = useUiLanguage();
  const { data } = useGame(api);
  const economy = data?.available === true ? data.economy : null;
  if (economy == null) return null;
  const lead = economy.pets[0];
  const lines: Array<{ key: string; text: string; strong: boolean }> = [];
  if (economy.goldenHour !== null) {
    lines.push({
      key: 'golden',
      strong: economy.goldenNow,
      text: economy.goldenNow
        ? pick(
            language,
            `Golden hour now: double XP until ${economy.goldenHour + 1}:00`,
            `Đang giờ vàng: x2 XP tới ${economy.goldenHour + 1}:00`,
          )
        : pick(
            language,
            `Today’s golden hour: ${economy.goldenHour}:00–${economy.goldenHour + 1}:00, double XP`,
            `Giờ vàng hôm nay: ${economy.goldenHour}:00–${economy.goldenHour + 1}:00, x2 XP`,
          ),
    });
  }
  if (economy.sunday)
    lines.push({ key: 'sunday', strong: true, text: pick(language, 'Sunday: +50% XP all day', 'Chủ nhật: +50% XP cả ngày') });
  if (economy.boostUntil !== null) {
    const until = new Date(economy.boostUntil).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
    lines.push({ key: 'boost', strong: true, text: pick(language, `Double XP until ${until}`, `x2 XP tới ${until}`) });
  }
  if (economy.petBonus > 0)
    lines.push({
      key: 'pets',
      strong: false,
      text: pick(language, `Companions: +${economy.petBonus}% XP`, `Linh vật: +${economy.petBonus}% XP`),
    });
  return (
    <section className={`${CARD} flex flex-col gap-3 p-4`} aria-label={pick(language, 'Bonuses and events', 'Thưởng và sự kiện')}>
      <div className="flex items-center gap-3">
        {lead !== undefined ? (
          <Link to={ROUTES.collection} className="shrink-0" aria-label={pick(language, 'Your companions', 'Linh vật của bạn')}>
            <PetArt id={lead.id} form={lead.form} mood={lead.mood} className="size-14" />
          </Link>
        ) : (
          <Link
            to={ROUTES.collection}
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
          >
            <Icon name="pet" className="size-6" />
          </Link>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className={SECTION_TITLE}>{pick(language, 'Bonuses', 'Thưởng thêm')}</h2>
          {lines.length === 0 ? (
            <p className={HELP}>
              {lead === undefined
                ? pick(language, 'Choose a companion: it adds XP as you study.', 'Chọn một linh vật: nó cộng XP khi bạn học.')
                : pick(language, 'No event right now.', 'Hiện không có sự kiện.')}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {lines.map((line) => (
                <li key={line.key} className={`text-xs ${line.strong ? 'font-semibold text-[#f0c75e]' : 'text-muted'}`}>
                  {line.text}
                </li>
              ))}
            </ul>
          )}
          {lead?.mood === 'sad' && (
            <p className="text-xs text-warn-ink">
              {pick(language, 'Your companion misses you. Study to cheer it up.', 'Linh vật đang nhớ bạn. Học một chút để nó vui lại.')}
            </p>
          )}
        </div>
      </div>
      {economy.month !== null && (
        <div className="flex flex-col gap-1">
          <span className="flex justify-between text-xs text-muted">
            <span>{pick(language, 'This month’s challenge', 'Thử thách tháng này')}</span>
            <span className="tabular-nums">
              {economy.month.done
                ? pick(language, 'Done', 'Hoàn thành')
                : `${Math.min(economy.month.count, economy.month.target)}/${economy.month.target}`}
            </span>
          </span>
          <ProgressBar share={economy.month.count / economy.month.target} />
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-xs">
        <Link
          to={ROUTES.boss}
          className="flex items-center gap-1 rounded-full border border-line px-3 py-1 font-medium text-ink hover:border-line-strong"
        >
          <Icon name="sword" className="size-3.5" />
          {pick(language, 'Weekly boss', 'Boss tuần')}
        </Link>
        <Link
          to={ROUTES.shop}
          className="flex items-center gap-1 rounded-full border border-line px-3 py-1 font-medium text-ink hover:border-line-strong"
        >
          <Icon name="star" className="size-3.5 text-[#f0c75e]" />
          {economy.stardust.toLocaleString(language)} · {pick(language, 'Shop', 'Cửa hàng')}
        </Link>
      </div>
    </section>
  );
}
