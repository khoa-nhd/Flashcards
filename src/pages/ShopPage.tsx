/**
 * The shop (docs/gamification-plan.md, 3.2): four items a day, new at
 * midnight, and the services always on sale. Bought with stardust only; the
 * server checks the price and that nothing is bought twice.
 */
import { useEffect, useState } from 'react';
import type { ShopResponse } from '../../shared/api.js';
import { itemById } from '../../shared/gamification/catalog.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { CardArt, PetArt, frameRing, rarityBorder } from '../components/Collectibles.js';
import { Icon, type IconName } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { fetchGameShared } from '../lib/game-state.js';
import { itemName, rarityName } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';

/** Time to the next midnight on this device, as "5h 12m". */
function untilMidnight(): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const minutes = Math.max(0, Math.round((next.getTime() - now.getTime()) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useClock(): string {
  const [text, setText] = useState(untilMidnight);
  useEffect(() => {
    const timer = setInterval(() => setText(untilMidnight()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return text;
}

/** What an item looks like on its shelf. */
export function ItemPicture({ id }: { id: string }) {
  const item = itemById(id);
  if (item === undefined) return null;
  if (item.kind === 'pet') return <PetArt id={id} form={2} className="h-24 w-24" />;
  if (item.kind === 'card') return <CardArt id={id} className="h-24 w-full" />;
  if (item.kind === 'frame') {
    return (
      <span
        className={`flex size-16 items-center justify-center rounded-full bg-paper/70 font-serif text-xl text-ink ${frameRing(id)}`}
        aria-hidden="true"
      >
        A
      </span>
    );
  }
  if (item.kind === 'theme') {
    const colour = { theme_dawn: '#f4b8c8', theme_aurora: '#86dcb6', theme_ember: '#f0b07a', theme_lilac: '#cfc5ff' }[id] ?? '#a5c9ee';
    return (
      <span
        className="block size-14 rounded-full"
        style={{ background: `radial-gradient(circle at 35% 35%, ${colour}, #101a2e 75%)` }}
        aria-hidden="true"
      />
    );
  }
  return <Icon name="star" className="size-10 text-[#f0c75e]" />;
}

const SERVICE: Record<ShopResponse['services'][number]['kind'], { icon: IconName; en: [string, string]; vi: [string, string] }> = {
  freeze: {
    icon: 'snow',
    en: ['Streak freeze', 'Covers one missed day. You can hold two.'],
    vi: ['Đóng băng streak', 'Che một ngày lỡ. Giữ tối đa hai cái.'],
  },
  boost: {
    icon: 'clock',
    en: ['Double XP, 15 minutes', 'Starts now; buying another adds 15 more.'],
    vi: ['x2 XP trong 15 phút', 'Bắt đầu ngay; mua thêm thì cộng 15 phút.'],
  },
  repair: {
    icon: 'refresh',
    en: ['Repair a streak', 'For a streak broken in the last two days.'],
    vi: ['Sửa streak đã đứt', 'Cho chuỗi bị đứt trong hai ngày gần đây.'],
  },
  slot: { icon: 'pet', en: ['Companion slot', 'One more companion can lead.'], vi: ['Ô linh vật', 'Thêm một linh vật được dẫn theo.'] },
};

function blockedText(language: UiLanguage, blocked: string | null): string | null {
  switch (blocked) {
    case 'held':
      return pick(language, 'You hold two already', 'Bạn đã giữ đủ hai cái');
    case 'owned':
      return pick(language, 'Bought', 'Đã mua');
    case 'nothing':
      return pick(language, 'No broken streak', 'Không có chuỗi nào bị đứt');
    default:
      return null;
  }
}

export function ShopPage() {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const shop = useRemote(api.fetchShop, 'Could not load the shop.');
  const clock = useClock();
  const [busy, setBusy] = useState<string | null>(null);

  const buy = async (key: string, request: Parameters<typeof api.buy>[0], name: string) => {
    setBusy(key);
    try {
      shop.adopt(await api.buy(request));
      toasts.show({ message: pick(language, `Bought: ${name}.`, `Đã mua: ${name}.`) });
      void fetchGameShared(api).catch(() => undefined);
    } catch (cause) {
      toasts.show({ message: cause instanceof ApiError ? cause.message : pick(language, 'Could not buy that.', 'Không mua được.') });
    } finally {
      setBusy(null);
    }
  };

  const data = shop.status === 'ready' ? shop.data : null;
  return (
    <div className={`${PAGE} mx-auto max-w-4xl`}>
      <PageHeader
        title={pick(language, 'Shop', 'Cửa hàng')}
        description={pick(
          language,
          'Spend stardust from levels, quests, chests and leagues. Four new items every day.',
          'Dùng bụi sao từ level, nhiệm vụ, rương và giải đấu. Mỗi ngày bốn món mới.',
        )}
        actions={
          data !== null && data.available ? (
            <span className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm font-semibold tabular-nums text-ink">
              <Icon name="star" className="size-4 text-[#f0c75e]" />
              {data.stardust.toLocaleString(language)}
            </span>
          ) : undefined
        }
      />
      {shop.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : shop.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {shop.error}
        </p>
      ) : !data!.available ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{data!.reason}</p>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className={SECTION_TITLE}>{pick(language, 'Today', 'Hôm nay')}</h2>
              <span className={HELP}>{pick(language, `New items in ${clock}`, `Món mới sau ${clock}`)}</span>
            </div>
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {data!.items.map((offer) => {
                const item = itemById(offer.item)!;
                const name = itemName(language, offer.item);
                return (
                  <li
                    key={offer.item}
                    className={`${CARD} flex flex-col items-center gap-2 border-2 p-3 text-center sm:gap-3 sm:p-4 ${rarityBorder(item.rarity)}`}
                  >
                    <div className="flex h-24 w-full items-center justify-center">
                      <ItemPicture id={offer.item} />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-ink">{name}</span>
                      <span className="text-[0.6875rem] uppercase tracking-wider text-faint">{rarityName(language, item.rarity)}</span>
                    </div>
                    <button
                      type="button"
                      className={`${BUTTON_PRIMARY} w-full`}
                      disabled={offer.owned || busy !== null || data!.stardust < offer.price}
                      onClick={() => void buy(offer.item, { kind: 'item', item: offer.item }, name)}
                    >
                      {busy === offer.item && <Spinner />}
                      {offer.owned ? pick(language, 'Owned', 'Đã có') : `${offer.price.toLocaleString(language)} ✦`}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className={SECTION_TITLE}>{pick(language, 'Always on sale', 'Luôn có bán')}</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {data!.services.map((service) => {
                const text = SERVICE[service.kind];
                const [name, detail] = language === 'vi' ? text.vi : text.en;
                const blocked = blockedText(language, service.blocked);
                return (
                  <li key={service.kind} className={`${CARD} flex items-center gap-4 p-4`}>
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <Icon name={text.icon} className="size-5" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-semibold text-ink">{name}</span>
                      <span className={HELP}>{blocked ?? detail}</span>
                    </span>
                    <button
                      type="button"
                      className={`${BUTTON_PRIMARY} shrink-0`}
                      disabled={service.blocked !== null || busy !== null || data!.stardust < service.price}
                      onClick={() => void buy(service.kind, { kind: service.kind }, name)}
                    >
                      {busy === service.kind && <Spinner />}
                      {service.price.toLocaleString(language)} ✦
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
