/**
 * Loot chests.
 *
 * The page only draws what the server rolled. The theatre around it — the
 * shaking lid, the light through the seams, the cards turning over — is CSS,
 * and the sounds are synthesised; the app ships no audio or artwork.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { GachaApiState, GachaOpeningResult } from '../../shared/api.js';
import {
  CHESTS,
  GACHA_ITEMS,
  itemById,
  type ChestType,
  type Rarity,
} from '../../shared/gacha.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { playGachaCue, setGachaSoundMuted, gachaSoundMuted } from '../lib/gacha-sound.js';
import { pick } from '../lib/i18n.js';

interface RarityLook {
  label: string;
  labelVi: string;
  card: string;
  chip: string;
  glow: string;
  spark: string;
}

/** One place for what each rarity looks and sounds like. */
const RARITY: Record<Rarity, RarityLook> = {
  common: {
    label: 'Common',
    labelVi: 'Thường',
    card: 'border-line-strong bg-surface',
    chip: 'border-line-strong text-muted',
    glow: 'rgba(148, 163, 184, 0.35)',
    spark: 'rgba(148, 163, 184, 0.8)',
  },
  rare: {
    label: 'Rare',
    labelVi: 'Hiếm',
    card: 'border-[rgb(96_165_250_/_0.55)] bg-[rgb(96_165_250_/_0.08)]',
    chip: 'border-[rgb(96_165_250_/_0.6)] text-[rgb(147_197_253)]',
    glow: 'rgba(96, 165, 250, 0.55)',
    spark: 'rgba(147, 197, 253, 0.95)',
  },
  epic: {
    label: 'Epic',
    labelVi: 'Sử thi',
    card: 'border-[rgb(192_132_252_/_0.6)] bg-[rgb(192_132_252_/_0.1)]',
    chip: 'border-[rgb(192_132_252_/_0.65)] text-[rgb(216_180_254)]',
    glow: 'rgba(192, 132, 252, 0.65)',
    spark: 'rgba(233, 213, 255, 0.95)',
  },
  legendary: {
    label: 'Legendary',
    labelVi: 'Huyền thoại',
    card: 'border-[rgb(251_191_36_/_0.75)] bg-[rgb(251_191_36_/_0.12)]',
    chip: 'border-[rgb(251_191_36_/_0.8)] text-[rgb(253_224_71)]',
    glow: 'rgba(251, 191, 36, 0.75)',
    spark: 'rgba(254, 240, 138, 1)',
  },
};

const CHEST_LOOK: Record<string, { body: string; lid: string; band: string }> = {
  wooden: { body: 'from-[#8a5a33] to-[#5d3a20]', lid: 'from-[#a06a3c] to-[#704628]', band: 'bg-[#3f2a19]' },
  silver: { body: 'from-[#b9c2cd] to-[#7c8794]', lid: 'from-[#d7dee6] to-[#98a3b0]', band: 'bg-[#5b6572]' },
  golden: { body: 'from-[#f0c14b] to-[#a9741a]', lid: 'from-[#ffe28a] to-[#c99a2e]', band: 'bg-[#7a5510]' },
};

function rarityLabel(language: 'vi' | 'en', rarity: Rarity): string {
  const look = RARITY[rarity];
  return pick(language, look.label, look.labelVi);
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function ChestsPage() {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const [state, setState] = useState<GachaApiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(() => gachaSoundMuted());
  const [opening, setOpening] = useState<{ chest: ChestType; count: number; results: GachaOpeningResult[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.fetchGacha();
      setState(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : pick(language, 'Your chests could not be loaded.', 'Không tải được rương.'));
    }
  }, [api, language]);

  // Loaded once the page is open, the way the calendar loads its days.
  useEffect(() => {
    let current = true;
    api.fetchGacha().then(
      (next) => {
        if (!current) return;
        setState(next);
        setError(null);
      },
      (cause: unknown) => {
        if (!current) return;
        setError(
          cause instanceof ApiError ? cause.message : pick(language, 'Your chests could not be loaded.', 'Không tải được rương.'),
        );
      },
    );
    return () => {
      current = false;
    };
  }, [api, language]);

  const owned = useMemo(() => new Map((state?.inventory ?? []).map((row) => [row.itemId, row.quantity])), [state]);
  const collected = useMemo(() => GACHA_ITEMS.filter((item) => owned.has(item.id)).length, [owned]);

  const toggleSound = () => {
    const next = !muted;
    setMuted(next);
    setGachaSoundMuted(next);
    if (!next) playGachaCue('tap');
  };

  const openChest = async (chest: ChestType, count: number) => {
    if (busy || state === null) return;
    if (state.keys < chest.costKeys * count) {
      toasts.show({ message: pick(language, 'Not enough keys for that.', 'Không đủ chìa khoá.') });
      return;
    }
    playGachaCue('tap');
    setBusy(true);
    try {
      const response = await api.openChest({ chestId: chest.id, count, requestId: crypto.randomUUID() });
      setState(response.state);
      setOpening({ chest, count, results: response.results });
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : pick(language, 'The chest would not open.', 'Không mở được rương.');
      toasts.show({ message });
      // The balance may have moved (another device, or a daily grant): show the truth.
      void load();
    } finally {
      setBusy(false);
    }
  };

  const exchange = async () => {
    if (busy || state === null || state.shards < state.shardsPerKey) return;
    setBusy(true);
    try {
      const response = await api.exchangeShards({ keys: 1, requestId: crypto.randomUUID() });
      setState(response.state);
      playGachaCue('rare');
      toasts.show({ message: pick(language, 'One key bought with shards.', 'Đã đổi mảnh lấy một chìa khoá.') });
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'The shards could not be traded.', 'Không đổi được mảnh.'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={PAGE}>
      <PageHeader
        title={pick(language, 'Chests', 'Rương kho báu')}
        description={pick(
          language,
          'Keys open chests. Whatever falls out is yours to keep; duplicates become shards.',
          'Chìa khoá mở rương. Đồ rơi ra là của bạn; đồ trùng đổi thành mảnh.',
        )}
        actions={
          <button type="button" className={BUTTON_GHOST} onClick={toggleSound} aria-pressed={muted}>
            {muted ? pick(language, 'Sound off', 'Tắt tiếng') : pick(language, 'Sound on', 'Bật tiếng')}
          </button>
        }
      />

      {error !== null && (
        <p role="alert" className="rounded-xl border border-bad/40 bg-bad-soft px-4 py-3 text-sm text-bad-ink">
          {error}
        </p>
      )}

      {state === null && error === null && (
        <p role="status" className="flex items-center gap-3 text-sm text-muted">
          <Spinner className="size-4" /> {pick(language, 'Opening the chest room…', 'Đang mở phòng kho…')}
        </p>
      )}

      {state !== null && (
        <>
          <section aria-label={pick(language, 'Your purse', 'Túi đồ')} className={`${CARD} flex flex-wrap items-center gap-4 p-4`}>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-2xl">🗝️</span>
              <span className="text-sm text-muted">{pick(language, 'Keys', 'Chìa khoá')}</span>
              <span className="text-xl font-semibold tabular-nums">{state.keys}</span>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-2xl">💎</span>
              <span className="text-sm text-muted">{pick(language, 'Shards', 'Mảnh')}</span>
              <span className="text-xl font-semibold tabular-nums">{state.shards}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted">
              {pick(language, `${collected} of ${GACHA_ITEMS.length} collectibles`, `${collected}/${GACHA_ITEMS.length} bộ sưu tập`)}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {state.dailyKeysAvailable && (
                <span className="rounded-full border border-good/40 bg-good-soft px-3 py-1 text-xs font-medium text-good-ink">
                  {pick(language, `${state.dailyKeys} free keys today`, `${state.dailyKeys} chìa miễn phí hôm nay`)}
                </span>
              )}
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => void exchange()}
                disabled={busy || state.shards < state.shardsPerKey}
              >
                {pick(
                  language,
                  `Trade ${state.shardsPerKey} shards → 1 key`,
                  `Đổi ${state.shardsPerKey} mảnh → 1 chìa`,
                )}
              </button>
            </div>
          </section>

          <section aria-label={pick(language, 'Chests for sale', 'Rương')} className="flex flex-col gap-3">
            <h2 className={SECTION_TITLE}>{pick(language, 'Choose a chest', 'Chọn rương')}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CHESTS.map((chest) => (
                <ChestCard
                  key={chest.id}
                  chest={chest}
                  state={state}
                  busy={busy}
                  language={language}
                  onOpen={(count) => void openChest(chest, count)}
                />
              ))}
            </div>
          </section>

          <section aria-label={pick(language, 'Collection', 'Bộ sưu tập')} className="flex flex-col gap-3">
            <h2 className={SECTION_TITLE}>{pick(language, 'Collection', 'Bộ sưu tập')}</h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {GACHA_ITEMS.map((item) => {
                const count = owned.get(item.id) ?? 0;
                const look = RARITY[item.rarity];
                return (
                  <li
                    key={item.id}
                    className={`flex items-center gap-3 rounded-xl border p-3 ${count > 0 ? look.card : 'border-line bg-paper'}`}
                    style={count > 0 ? { boxShadow: `0 0 18px -6px ${look.glow}` } : undefined}
                  >
                    <span aria-hidden="true" className={`text-2xl ${count > 0 ? '' : 'opacity-25 grayscale'}`}>
                      {count > 0 ? item.glyph : '❓'}
                    </span>
                    <span className="min-w-0">
                      <span className={`block truncate text-sm font-semibold ${count > 0 ? 'text-ink' : 'text-faint'}`}>
                        {count > 0 ? pick(language, item.name, item.nameVi) : pick(language, 'Undiscovered', 'Chưa tìm ra')}
                      </span>
                      <span className={`mt-0.5 block text-xs ${count > 0 ? 'text-muted' : 'text-faint'}`}>
                        {count > 0 ? `${rarityLabel(language, item.rarity)} · ×${count}` : rarityLabel(language, item.rarity)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {opening !== null && (
        <OpeningOverlay
          chest={opening.chest}
          count={opening.count}
          results={opening.results}
          language={language}
          onDone={() => setOpening(null)}
        />
      )}
    </div>
  );
}

function ChestCard({
  chest,
  state,
  busy,
  language,
  onOpen,
}: {
  chest: ChestType;
  state: GachaApiState;
  busy: boolean;
  language: 'vi' | 'en';
  onOpen: (count: number) => void;
}) {
  const look = CHEST_LOOK[chest.id] ?? CHEST_LOOK.wooden!;
  const tenCost = chest.costKeys * 10;
  return (
    <article className={`${CARD} flex flex-col gap-3 p-4`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-serif text-lg font-semibold">{pick(language, chest.name, chest.nameVi)}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">{pick(language, chest.description, chest.descriptionVi)}</p>
        </div>
        <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-xs font-semibold tabular-nums">
          🗝️ {chest.costKeys}
        </span>
      </div>

      <div className="relative mx-auto flex h-24 w-full items-end justify-center" aria-hidden="true">
        <div className={`absolute bottom-0 h-14 w-28 rounded-md bg-gradient-to-b ${look.body} shadow-inner`} />
        <div className={`absolute bottom-12 h-6 w-32 rounded-t-lg bg-gradient-to-b ${look.lid} shadow-lg`} />
        <div className={`absolute bottom-0 h-14 w-3 rounded-sm ${look.band}`} />
        <span className="absolute bottom-5 text-lg">🔒</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
        {(['common', 'rare', 'epic', 'legendary'] as const).map((rarity) => (
          <div key={rarity} className="flex items-baseline justify-between gap-2">
            <dt className={RARITY[rarity].chip.split(' ').pop()}>{rarityLabel(language, rarity)}</dt>
            <dd className="tabular-nums">{(chest.rates[rarity] * 100).toFixed(0)}%</dd>
          </div>
        ))}
      </dl>

      <div className="rounded-lg border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-muted">
        <p>
          {pick(
            language,
            `Pity: an epic within ${Math.max(0, chest.epicPity - state.pity.sinceEpic)} more, a legendary within ${Math.max(0, chest.hardPity - state.pity.sinceLegendary)}.`,
            `Bảo hiểm: còn ${Math.max(0, chest.epicPity - state.pity.sinceEpic)} lượt tới sử thi, ${Math.max(0, chest.hardPity - state.pity.sinceLegendary)} lượt tới huyền thoại.`,
          )}
        </p>
        {state.pity.sinceLegendary >= chest.softPityAfter && (
          <p className="mt-1 font-medium text-warn-ink">
            {pick(language, 'Soft pity: the legendary odds are climbing.', 'Bảo hiểm mềm: tỉ lệ huyền thoại đang tăng.')}
          </p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON_PRIMARY}
          disabled={busy || state.keys < chest.costKeys}
          onClick={() => onOpen(1)}
        >
          {pick(language, 'Open', 'Mở')} · 🗝️ {chest.costKeys}
        </button>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy || state.keys < tenCost}
          onClick={() => onOpen(10)}
        >
          {pick(language, 'Open 10×', 'Mở 10×')} · 🗝️ {tenCost}
        </button>
      </div>
    </article>
  );
}

type Phase = 'charge' | 'burst' | 'reveal' | 'summary';

/**
 * The opening itself: the lid strains, the light breaks, then each card turns
 * over. A legendary lengthens the wait and the lights, because the wait is what
 * makes it worth telling someone about.
 */
function OpeningOverlay({
  chest,
  count,
  results,
  language,
  onDone,
}: {
  chest: ChestType;
  count: number;
  results: GachaOpeningResult[];
  language: 'vi' | 'en';
  onDone: () => void;
}) {
  const best = results.reduce<Rarity>((top, result) => {
    const order: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
    return order.indexOf(result.rarity) > order.indexOf(top) ? result.rarity : top;
  }, 'common');
  const [phase, setPhase] = useState<Phase>('charge');
  const [revealed, setRevealed] = useState(0);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  };
  const after = (ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  };

  // The build-up. A legendary chest is given longer, so the room can go quiet.
  const chargeMs = best === 'legendary' ? 1900 : best === 'epic' ? 1250 : 800;
  useEffect(() => {
    playGachaCue('charge');
    after(chargeMs, () => {
      setPhase('burst');
      playGachaCue('burst');
      after(450, () => {
        setPhase('reveal');
        playGachaCue(best === 'legendary' ? 'legendary' : best === 'epic' ? 'epic' : best === 'rare' ? 'rare' : 'common');
      });
    });
    return clearTimers;
    // Runs once: the opening is already decided.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One card at a time, so a batch still feels like ten separate moments.
  useEffect(() => {
    if (phase !== 'reveal' || revealed >= results.length) return;
    const timer = window.setTimeout(() => {
      const next = revealed + 1;
      setRevealed(next);
      const result = results[revealed];
      if (result !== undefined && result.rarity !== 'common' && next > 1) playGachaCue(result.duplicate ? 'duplicate' : 'tap');
    }, revealed === 0 ? 250 : 420);
    return () => window.clearTimeout(timer);
  }, [phase, revealed, results]);

  useEffect(() => {
    if (phase !== 'reveal' || revealed < results.length) return;
    // A single card stays up until it is dismissed; a batch ends in a summary.
    if (results.length === 1) return;
    const timer = window.setTimeout(() => setPhase('summary'), 650);
    return () => window.clearTimeout(timer);
  }, [phase, revealed, results.length]);

  useEffect(() => () => clearTimers(), []);

  const shards = results.reduce((total, result) => total + result.shards, 0);
  const skip = () => {
    clearTimers();
    setRevealed(results.length);
    setPhase(results.length > 1 ? 'summary' : 'reveal');
    playGachaCue('tap');
  };

  const current = results[revealed - 1] ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pick(language, 'Opening chest', 'Đang mở rương')}
      className="fixed inset-0 z-[95] flex flex-col items-center justify-center gap-6 overflow-y-auto bg-scrim px-4 py-8 text-center backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') skip();
      }}
    >
      <style>{`@keyframes gacha-shake { 0%,100% { transform: translate3d(0,0,0) rotate(-1deg) } 25% { transform: translate3d(-3px,-1px,0) rotate(1.5deg) } 50% { transform: translate3d(3px,1px,0) rotate(-2deg) } 75% { transform: translate3d(-2px,0,0) rotate(1deg) } }
@keyframes gacha-flash { 0% { opacity: 0; transform: scale(0.4) } 40% { opacity: 1 } 100% { opacity: 0; transform: scale(2.2) } }
@keyframes gacha-card { 0% { opacity: 0; transform: translateY(28px) rotateX(70deg) scale(0.85) } 100% { opacity: 1; transform: translateY(0) rotateX(0deg) scale(1) } }
@keyframes gacha-spark { 0% { opacity: 0; transform: translate3d(0,0,0) scale(0.4) } 30% { opacity: 1 } 100% { opacity: 0; transform: translate3d(var(--dx), var(--dy), 0) scale(1) } }`}</style>

      {phase === 'charge' && (
        <div className="flex flex-col items-center gap-5">
          <div
            className="relative"
            style={{ animation: `gacha-shake ${best === 'legendary' ? '0.5s' : '0.75s'} ease-in-out infinite` }}
            aria-hidden="true"
          >
            <div className={`h-24 w-40 rounded-md bg-gradient-to-b ${CHEST_LOOK[chest.id]?.body ?? CHEST_LOOK.wooden!.body}`} />
            <div className={`absolute -top-8 h-10 w-44 rounded-t-xl bg-gradient-to-b ${CHEST_LOOK[chest.id]?.lid ?? CHEST_LOOK.wooden!.lid}`} />
            <div
              className="absolute -top-1 left-0 h-1.5 w-full rounded-full"
              style={{
                background: `linear-gradient(90deg, transparent, ${RARITY[best].spark}, transparent)`,
                filter: 'blur(3px)',
                animation: 'gacha-flash 0.9s ease-in-out infinite',
              }}
            />
          </div>
          <p role="status" className="text-sm text-muted">
            {best === 'legendary'
              ? pick(language, 'The lid is holding. Something bright is behind it…', 'Nắp rương đang giữ lại. Có gì đó rất sáng ở bên trong…')
              : pick(language, 'The chest is waking up…', 'Rương đang thức dậy…')}
          </p>
        </div>
      )}

      {phase === 'burst' && (
        <div className="relative flex size-56 items-center justify-center" aria-hidden="true">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `radial-gradient(circle, ${RARITY[best].spark} 0%, transparent 65%)`,
              animation: 'gacha-flash 0.45s ease-out forwards',
            }}
          />
          <div className="text-6xl" style={{ animation: 'gacha-flash 0.45s ease-out forwards' }}>
            {itemById(results[0]?.itemId ?? '')?.glyph ?? '✨'}
          </div>
        </div>
      )}

      {phase === 'reveal' && current !== null && (
        <div className="flex w-full max-w-md flex-col items-center gap-5">
          <ul className="flex flex-wrap items-center justify-center gap-2" aria-label={pick(language, 'Revealed so far', 'Đã lật')}>
            {results.slice(0, revealed).map((result, index) => (
              <li
                key={`${result.itemId}-${index}`}
                className={`size-2.5 rounded-full ${index === revealed - 1 ? 'bg-accent' : 'bg-line-strong'}`}
                aria-hidden="true"
              />
            ))}
          </ul>
          <RewardCard result={current} language={language} />
          <p className="text-xs text-muted" aria-live="polite">
            {pick(language, `${revealed} of ${results.length}`, `${revealed}/${results.length}`)}
          </p>
          {revealed < results.length && (
            <button type="button" className={BUTTON_GHOST} onClick={skip}>
              {pick(language, 'Skip the rest', 'Bỏ qua phần còn lại')}
            </button>
          )}
          {revealed >= results.length && results.length === 1 && (
            <button type="button" className={BUTTON_PRIMARY} onClick={onDone} autoFocus>
              {pick(language, 'Lovely', 'Tuyệt')}
            </button>
          )}
        </div>
      )}

      {phase === 'summary' && (
        <div className="flex w-full max-w-lg flex-col gap-4">
          <h2 className="font-serif text-2xl font-semibold">{pick(language, `All ${count} opened`, `Đã mở ${count} rương`)}</h2>
          <ul className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto text-left">
            {results.map((result, index) => {
              const item = itemById(result.itemId);
              const look = RARITY[result.rarity];
              return (
                <li
                  key={`${result.itemId}-${index}`}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${look.card}`}
                  style={{ boxShadow: `0 0 20px -8px ${look.glow}` }}
                >
                  <span aria-hidden="true" className="text-xl">{item?.glyph ?? '✨'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {item === null || item === undefined ? result.itemId : pick(language, item.name, item.nameVi)}
                    </span>
                    <span className={`text-xs ${look.chip.split(' ').pop()}`}>{rarityLabel(language, result.rarity)}</span>
                  </span>
                  {result.duplicate ? (
                    <span className="shrink-0 text-xs text-muted">💎 {signed(result.shards)}</span>
                  ) : (
                    <span className="shrink-0 text-xs font-medium text-good-ink">{pick(language, 'New', 'Mới')}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {shards > 0 && (
            <p className="text-sm text-muted">
              {pick(language, `Duplicates became ${shards} shards.`, `Đồ trùng đổi thành ${shards} mảnh.`)}
            </p>
          )}
          <button type="button" className={BUTTON_PRIMARY} onClick={onDone} autoFocus>
            {pick(language, 'Keep them', 'Giữ lại')}
          </button>
        </div>
      )}
    </div>
  );
}

function RewardCard({ result, language }: { result: GachaOpeningResult; language: 'vi' | 'en' }) {
  const item = itemById(result.itemId);
  const look = RARITY[result.rarity];
  // Spread evenly around the card, so the same card always sparks the same
  // way and a re-render cannot reshuffle it.
  const sparks = useMemo(() => {
    const count = result.rarity === 'legendary' ? 18 : result.rarity === 'epic' ? 12 : 8;
    return Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 + index * 0.7;
      const radius = 60 + ((index * 37) % 60);
      return {
        dx: `${Math.round(Math.cos(angle) * radius)}px`,
        dy: `${Math.round(Math.sin(angle) * radius)}px`,
        delay: `${index * 40}ms`,
      };
    });
  }, [result.rarity]);

  return (
    <div
      className={`relative w-full overflow-hidden rounded-2xl border-2 p-6 ${look.card}`}
      style={{ boxShadow: `0 0 60px -12px ${look.glow}` }}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {sparks.map((spark, index) => (
          <span
            key={index}
            className="absolute left-1/2 top-1/2 size-1.5 rounded-full"
            style={
              {
                background: look.spark,
                '--dx': spark.dx,
                '--dy': spark.dy,
                animation: `gacha-spark 900ms ease-out ${spark.delay} forwards`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div style={{ animation: 'gacha-card 380ms cubic-bezier(0.2, 0.9, 0.3, 1.2)' }}>
        <p className={`text-[0.6875rem] font-semibold uppercase tracking-[0.16em] ${look.chip.split(' ').pop()}`}>
          {rarityLabel(language, result.rarity)}
        </p>
        <div className="mt-2 text-5xl" aria-hidden="true">
          {item?.glyph ?? '✨'}
        </div>
        <h3 className="mt-2 font-serif text-xl font-semibold">
          {item === null || item === undefined ? result.itemId : pick(language, item.name, item.nameVi)}
        </h3>
        {item !== null && item !== undefined && (
          <p className="mt-1 text-sm text-muted">{pick(language, item.flavor, item.flavorVi)}</p>
        )}
        {result.duplicate ? (
          <p className="mt-3 text-xs font-medium text-muted">
            {pick(language, `Already yours — recycled into ${result.shards} shards.`, `Đã có sẵn — đổi thành ${result.shards} mảnh.`)}
          </p>
        ) : (
          <p className="mt-3 text-xs font-medium text-good-ink">{pick(language, 'New in your collection.', 'Món mới trong bộ sưu tập.')}</p>
        )}
      </div>
    </div>
  );
}
