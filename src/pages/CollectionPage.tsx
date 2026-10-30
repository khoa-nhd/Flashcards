/**
 * Everything collected (docs/gamification-plan.md, 3.4 and 3.5): companions
 * and which lead, frames and titles to wear on the profile, colour themes,
 * and the 88 constellation cards with their sets.
 */
import { useCallback, useState } from 'react';
import type { CollectionResponse } from '../../shared/api.js';
import { CARD_SETS, ITEMS, PETS, itemById, type Pet } from '../../shared/gamification/catalog.js';
import { petForm } from '../../shared/gamification/economy.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { CardArt, PetArt, rarityBorder } from '../components/Collectibles.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { fetchGameShared } from '../lib/game-state.js';
import { itemName } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { ItemPicture } from './ShopPage.js';

function skillText(language: UiLanguage, pet: Pet): string {
  const skill = pet.skill;
  if (skill.kind === 'xp') return pick(language, `+${skill.percent}% XP`, `+${skill.percent}% XP`);
  if (skill.kind === 'combo')
    return pick(language, `+${skill.percent}% XP · combo lasts a minute longer`, `+${skill.percent}% XP · combo giữ thêm 1 phút`);
  return pick(language, `+${skill.xp}% XP · rare chests +${skill.percent}%`, `+${skill.xp}% XP · rương hiếm +${skill.percent}%`);
}

function Starter({ language, onChosen }: { language: UiLanguage; onChosen: (collection: CollectionResponse) => void }) {
  const { api, toasts } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const choose = async (pet: string) => {
    setBusy(pet);
    try {
      onChosen(await api.chooseStarter(pet));
      void fetchGameShared(api).catch(() => undefined);
    } catch (cause) {
      toasts.show({ message: cause instanceof ApiError ? cause.message : pick(language, 'Could not choose.', 'Không chọn được.') });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className={`${CARD} pool pool-top flex flex-col gap-4 p-5`}>
      <div>
        <h2 className={SECTION_TITLE}>{pick(language, 'Choose your first companion', 'Chọn linh vật đầu tiên')}</h2>
        <p className={`${HELP} mt-1`}>
          {pick(
            language,
            'It studies with you, grows as you do, and adds a little XP. The others come from chests.',
            'Nó học cùng bạn, lớn lên theo bạn, và cộng thêm chút XP. Những con khác có trong rương.',
          )}
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {PETS.map((pet) => (
          <li key={pet.id}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void choose(pet.id)}
              className="flex w-full flex-col items-center gap-1 rounded-xl border border-line p-3 text-center transition-colors hover:border-accent/60 hover:bg-accent-soft"
            >
              <PetArt id={pet.id} form={1} className="size-20" />
              <span className="text-sm font-semibold text-ink">{pick(language, pet.en, pet.vi)}</span>
              <span className="text-[0.6875rem] text-faint">{skillText(language, pet)}</span>
              {busy === pet.id && <Spinner />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Companions({
  data,
  language,
  onSaved,
}: {
  data: CollectionResponse;
  language: UiLanguage;
  onSaved: (collection: CollectionResponse) => void;
}) {
  const { api, toasts } = useApp();
  const [busy, setBusy] = useState(false);
  const owned = PETS.filter((pet) => data.owned.includes(pet.id));
  const toggle = async (id: string) => {
    const leading = data.leading.includes(id) ? data.leading.filter((each) => each !== id) : [...data.leading, id];
    if (leading.length > data.slots) {
      toasts.show({ message: pick(language, 'Every slot is taken. Let one rest first.', 'Đã hết ô. Cho một con nghỉ trước.') });
      return;
    }
    setBusy(true);
    try {
      onSaved(await api.equip({ pets: leading }));
      void fetchGameShared(api).catch(() => undefined);
    } catch (cause) {
      toasts.show({ message: cause instanceof ApiError ? cause.message : pick(language, 'Could not change that.', 'Không đổi được.') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={SECTION_TITLE}>{pick(language, 'Companions', 'Linh vật')}</h2>
        <span className={HELP}>
          {pick(
            language,
            `Leading ${data.leading.length} of ${data.slots} slots · XP from companions is capped at +25%`,
            `Dẫn theo ${data.leading.length}/${data.slots} ô · XP từ linh vật tối đa +25%`,
          )}
        </span>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {owned.map((pet) => {
          const days = data.petDays[pet.id] ?? 0;
          const leading = data.leading.includes(pet.id);
          return (
            <li
              key={pet.id}
              className={`flex items-center gap-3 rounded-xl border p-3 ${leading ? 'border-accent/50 bg-accent-soft' : 'border-line'}`}
            >
              <PetArt id={pet.id} form={petForm(days)} className="size-16 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-ink">{pick(language, pet.en, pet.vi)}</span>
                <span className="text-[0.6875rem] text-faint">
                  {pick(
                    language,
                    `Form ${petForm(days)} of 4 · ${days} days together`,
                    `Hình dạng ${petForm(days)}/4 · ${days} ngày cùng học`,
                  )}
                </span>
                <span className="text-[0.6875rem] text-muted">{skillText(language, pet)}</span>
              </span>
              <button
                type="button"
                className={leading ? BUTTON_SECONDARY : BUTTON_PRIMARY}
                disabled={busy}
                onClick={() => void toggle(pet.id)}
                aria-pressed={leading}
              >
                {leading ? pick(language, 'Leading', 'Đang dẫn') : pick(language, 'Lead', 'Dẫn theo')}
              </button>
            </li>
          );
        })}
      </ul>
      <p className={HELP}>
        {pick(
          language,
          'Slots: one to start, one at level 20, one on first reaching Gold, one from the shop, one from a key in a legendary chest. Two days away makes a companion sad; studying cheers it up.',
          'Ô: một ô sẵn có, một ô khi đạt level 20, một ô khi lần đầu lên hạng Vàng, một ô mua ở cửa hàng, một ô mở bằng chìa khóa trong rương huyền thoại. Hai ngày không học thì linh vật buồn; học lại thì vui.',
        )}
      </p>
    </section>
  );
}

function Wearables({
  data,
  language,
  onTheme,
}: {
  data: CollectionResponse;
  language: UiLanguage;
  onTheme: (collection: CollectionResponse) => void;
}) {
  const { api, toasts } = useApp();
  const load = useCallback(() => api.fetchProfile(null), [api]);
  const profile = useRemote(load, 'Could not load your profile.');
  const [busy, setBusy] = useState<string | null>(null);
  const owned = (kind: 'frame' | 'title' | 'theme') => ITEMS.filter((item) => item.kind === kind && data.owned.includes(item.id));

  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
    } catch (cause) {
      toasts.show({ message: cause instanceof ApiError ? cause.message : pick(language, 'Could not change that.', 'Không đổi được.') });
    } finally {
      setBusy(null);
    }
  };
  const wear = (kind: 'frame' | 'title', id: string | null) =>
    act(`${kind}:${id ?? ''}`, async () => profile.adopt(await api.saveProfile(kind === 'frame' ? { frame: id } : { title: id })));
  const chooseTheme = (id: string | null) =>
    act(`theme:${id ?? ''}`, async () => {
      onTheme(await api.equip({ theme: id }));
      void fetchGameShared(api).catch(() => undefined);
    });

  const worn = profile.status === 'ready' ? profile.data : null;
  const row = (kind: 'frame' | 'title' | 'theme', current: string | null, choose: (id: string | null) => Promise<void>) => {
    const items = owned(kind);
    return (
      <ul className="flex flex-wrap gap-2">
        <li>
          <button
            type="button"
            className={current === null ? BUTTON_SECONDARY : BUTTON_GHOST}
            aria-pressed={current === null}
            disabled={busy !== null}
            onClick={() => void choose(null)}
          >
            {pick(language, 'None', 'Không dùng')}
          </button>
        </li>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={current === item.id ? BUTTON_SECONDARY : BUTTON_GHOST}
              aria-pressed={current === item.id}
              disabled={busy !== null}
              onClick={() => void choose(item.id)}
            >
              {busy === `${kind}:${item.id}` && <Spinner />}
              {itemName(language, item.id)}
            </button>
          </li>
        ))}
      </ul>
    );
  };
  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Frames, titles and themes', 'Khung, danh hiệu và giao diện')}</h2>
      {worn !== null && (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">
              {pick(language, 'Avatar frame', 'Khung đại diện')}
            </span>
            {row('frame', worn.frame, (id) => wear('frame', id))}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-faint">
              {pick(language, 'Title under your nickname', 'Danh hiệu dưới biệt danh')}
            </span>
            {row('title', worn.title, (id) => wear('title', id))}
          </div>
        </>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-faint">{pick(language, 'Colour theme', 'Màu giao diện')}</span>
        {row('theme', data.theme, chooseTheme)}
      </div>
    </section>
  );
}

function Cards({ data, language }: { data: CollectionResponse; language: UiLanguage }) {
  const cards = ITEMS.filter((item) => item.kind === 'card');
  const have = cards.filter((card) => data.owned.includes(card.id)).length;
  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={SECTION_TITLE}>{pick(language, 'Constellations', 'Chòm sao')}</h2>
        <span className={`${HELP} tabular-nums`}>
          {have}/{cards.length}
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {CARD_SETS.map((set) => {
          const progress = data.sets.find((each) => each.id === set.id);
          return (
            <li key={set.id} className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-sm">
              <span className="font-medium text-ink">{pick(language, set.en, set.vi)}</span>
              <span className={progress?.done ? 'text-xs font-semibold text-good-ink' : 'text-xs tabular-nums text-faint'}>
                {progress?.done ? pick(language, 'Complete', 'Đủ bộ') : `${progress?.have ?? 0}/${set.cards.length}`} · +{set.stardust} ✦
              </span>
            </li>
          );
        })}
      </ul>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {cards.map((card) => {
          const owned = data.owned.includes(card.id);
          return (
            <li
              key={card.id}
              title={itemName(language, card.id)}
              className={`flex flex-col gap-1 rounded-lg border p-1.5 ${owned ? rarityBorder(card.rarity) : 'border-line opacity-35'}`}
            >
              {owned ? (
                <CardArt id={card.id} className="h-14 w-full" />
              ) : (
                <span className="flex h-14 items-center justify-center text-faint">?</span>
              )}
              <span className="truncate text-center text-[0.625rem] text-muted">{owned ? itemName(language, card.id) : '···'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function CollectionPage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const collection = useRemote(api.fetchCollection, 'Could not load your collection.');
  const data = collection.status === 'ready' ? collection.data : null;
  const hasPet = data !== null && data.owned.some((id) => itemById(id)?.kind === 'pet');
  return (
    <div className={`${PAGE} mx-auto max-w-4xl`}>
      <PageHeader
        title={pick(language, 'Companions and cards', 'Kho đồ')}
        description={pick(
          language,
          'Everything from chests, the shop and sets. Nothing can be traded or bought with money.',
          'Mọi thứ từ rương, cửa hàng và bộ sưu tập. Không trao đổi, không mua bằng tiền thật.',
        )}
        actions={
          data !== null && data.available ? (
            <>
              <Link to={ROUTES.boss} className={BUTTON_SECONDARY}>
                <Icon name="sword" className="size-4" />
                {pick(language, 'Weekly boss', 'Boss tuần')}
              </Link>
              <Link to={ROUTES.shop} className={BUTTON_PRIMARY}>
                <Icon name="star" className="size-4" />
                {data.stardust.toLocaleString(language)}
              </Link>
            </>
          ) : undefined
        }
      />
      {collection.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
        </p>
      ) : collection.status === 'failed' ? (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {collection.error}
        </p>
      ) : !data!.available ? (
        <p className={`${CARD} p-5 text-sm text-muted`}>{data!.reason}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {hasPet ? (
            <Companions data={data!} language={language} onSaved={collection.adopt} />
          ) : (
            <Starter language={language} onChosen={collection.adopt} />
          )}
          <Wearables data={data!} language={language} onTheme={collection.adopt} />
          <Cards data={data!} language={language} />
          {data!.owned.some((id) => itemById(id)?.kind === 'slot') && (
            <section className={`${CARD} flex flex-wrap items-center gap-3 p-5`}>
              {data!.owned
                .filter((id) => itemById(id)?.kind === 'slot')
                .map((id) => (
                  <span key={id} className="flex items-center gap-2 text-sm text-ink">
                    <ItemPicture id={id} /> {itemName(language, id)}
                  </span>
                ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
