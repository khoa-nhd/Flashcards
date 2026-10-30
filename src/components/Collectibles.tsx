/**
 * How collected things look (docs/gamification-plan.md, 3.4): companions in
 * their four forms, constellation cards, avatar frames and colour themes. All
 * drawn here as SVG and CSS in the app's night style.
 *
 * A card's picture is decoration drawn from its id, not a star map.
 */
import { useEffect, type ReactNode } from 'react';
import { itemById, type Rarity } from '../../shared/gamification/catalog.js';
import { seededRandom } from '../../shared/gamification/quests.js';

const PET_COLOURS: Record<string, { body: string; belly: string; accent: string }> = {
  pet_owl: { body: '#8c7bd6', belly: '#d9d0ff', accent: '#f3e6b4' },
  pet_rabbit: { body: '#e7e3f3', belly: '#ffffff', accent: '#f4b8c8' },
  pet_fox: { body: '#e48a4f', belly: '#ffe6cf', accent: '#f7e08c' },
  pet_cat: { body: '#9fb6d6', belly: '#e9f1fb', accent: '#ffffff' },
  pet_whale: { body: '#4f78c4', belly: '#a9c4f0', accent: '#a5e0ee' },
  pet_dragon: { body: '#5fbf96', belly: '#c9f0dc', accent: '#f0c75e' },
};

/** A companion, growing with its form (1 to 4); a sad one droops. */
export function PetArt({
  id,
  form = 1,
  mood = 'happy',
  className = 'size-20',
}: {
  id: string;
  form?: number;
  mood?: 'happy' | 'sad';
  className?: string;
}) {
  const colour = PET_COLOURS[id] ?? PET_COLOURS.pet_owl!;
  // Bigger with each form, from a small first form to a full-grown fourth.
  const scale = [0.62, 0.76, 0.88, 1][Math.min(4, Math.max(1, form)) - 1]!;
  const sad = mood === 'sad';
  const eyes = sad ? (
    <g stroke="#1c2140" strokeWidth="2.4" strokeLinecap="round" fill="none">
      <path d="M38 50q4 3 8 0M54 50q4 3 8 0" />
    </g>
  ) : (
    <g fill="#1c2140">
      <circle cx="42" cy="49" r="3.6" />
      <circle cx="58" cy="49" r="3.6" />
      <circle cx="43.2" cy="47.8" r="1.1" fill="#fff" />
      <circle cx="59.2" cy="47.8" r="1.1" fill="#fff" />
    </g>
  );
  const ears: Record<string, ReactNode> = {
    pet_owl: <path d="M30 32 36 18 44 30M70 32 64 18 56 30" fill={colour.body} />,
    pet_rabbit: (
      <g fill={colour.body}>
        <ellipse cx="40" cy="18" rx="6" ry="16" />
        <ellipse cx="60" cy="18" rx="6" ry="16" />
        <ellipse cx="40" cy="19" rx="2.6" ry="11" fill={colour.accent} />
        <ellipse cx="60" cy="19" rx="2.6" ry="11" fill={colour.accent} />
      </g>
    ),
    pet_fox: <path d="M28 36 33 14 46 30M72 36 67 14 54 30" fill={colour.body} />,
    pet_cat: <path d="M31 34 34 18 45 29M69 34 66 18 55 29" fill={colour.body} />,
    pet_whale: (
      <path
        d="M50 22c-2-6-8-8-12-6m12 6c2-6 8-8 12-6M50 22v-6"
        stroke={colour.accent}
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
    ),
    pet_dragon: (
      <g fill={colour.accent}>
        <path d="M36 28 33 14 42 26" />
        <path d="M64 28 67 14 58 26" />
      </g>
    ),
  };
  const extras: Record<string, ReactNode> = {
    pet_fox: <path d="M74 70c12-2 16 8 10 14-4 4-10 2-12-2" fill={colour.body} />,
    pet_cat: <path d="M20 84c4-8 14-8 18-2 4-8 18-8 22 0 6-6 18-4 20 4Z" fill="#e9eef7" opacity="0.9" />,
    pet_dragon: <path d="M24 54c-10-6-14 4-8 10 4 4 10 2 12 0M76 54c10-6 14 4 8 10-4 4-10 2-12 0" fill={colour.body} opacity="0.85" />,
    pet_whale: <path d="M74 64c8 0 12-6 14-10 0 6-2 12-10 14" fill={colour.body} />,
  };
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {form >= 4 && <circle cx="50" cy="55" r="46" fill={colour.accent} opacity="0.12" />}
      {form >= 3 && (
        <g fill={colour.accent}>
          <circle cx="16" cy="22" r="1.8" />
          <circle cx="86" cy="30" r="1.4" />
          <circle cx="80" cy="12" r="1.1" />
        </g>
      )}
      <g transform={`translate(50 ${sad ? 60 : 56}) scale(${scale}) translate(-50 -56)`}>
        {extras[id]}
        {ears[id]}
        <ellipse cx="50" cy={sad ? 60 : 58} rx="26" ry={sad ? 24 : 26} fill={colour.body} />
        <ellipse cx="50" cy="66" rx="15" ry="14" fill={colour.belly} />
        {eyes}
        <path d={sad ? 'M46 60q4-2 8 0' : 'M46 58q4 3 8 0'} stroke="#1c2140" strokeWidth="2" fill="none" strokeLinecap="round" />
        {form >= 4 && <path d="m50 22 2 4.5 5 .6-3.7 3.4 1 4.9L50 33l-4.3 2.4 1-4.9-3.7-3.4 5-.6Z" fill={colour.accent} />}
      </g>
    </svg>
  );
}

const RARITY_GLOW: Record<Rarity, string> = {
  common: 'border-line',
  rare: 'border-[#7fb5c9]/60',
  epic: 'border-[#a99be8]/70',
  legendary: 'border-[#f0c75e]/80 shadow-[0_0_30px_-8px_rgb(240_199_94_/_0.6)]',
};

export const rarityBorder = (rarity: Rarity) => RARITY_GLOW[rarity];

/** A constellation card's picture: a few stars joined in a line, drawn from the card's id. */
export function CardArt({ id, className = 'h-24 w-full' }: { id: string; className?: string }) {
  const random = seededRandom(`card-art:${id}`);
  const count = 4 + Math.floor(random() * 4);
  const stars = Array.from({ length: count }, () => ({ x: 12 + random() * 76, y: 12 + random() * 56, r: 1.2 + random() * 2 }));
  const path = stars.map((star, at) => `${at === 0 ? 'M' : 'L'}${star.x.toFixed(1)} ${star.y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
      <rect width="100" height="80" rx="6" fill="#0d1729" />
      {Array.from({ length: 18 }, (_, at) => (
        <circle key={at} cx={(at * 37) % 100} cy={(at * 23) % 80} r="0.5" fill="#ffffff" opacity="0.35" />
      ))}
      <path d={path} stroke="#a5c9ee" strokeWidth="0.8" fill="none" opacity="0.7" />
      {stars.map((star, at) => (
        <circle key={at} cx={star.x} cy={star.y} r={star.r} fill="#f3e6b4" />
      ))}
    </svg>
  );
}

/** The ring an avatar frame draws. */
const FRAMES: Record<string, string> = {
  frame_moon: 'ring-2 ring-[#f3e6b4]/80',
  frame_frost: 'ring-2 ring-[#bfe3f2]',
  frame_dusk: 'ring-2 ring-[#e6a37a]',
  frame_aurora: 'ring-[3px] ring-[#86dcb6] shadow-[0_0_24px_-4px_rgb(134_220_182_/_0.6)]',
  frame_comet: 'ring-[3px] ring-[#b3c6ff] shadow-[0_0_24px_-4px_rgb(179_198_255_/_0.6)]',
  frame_nebula: 'ring-4 ring-[#cfc5ff] shadow-[0_0_30px_-4px_rgb(207_197_255_/_0.7)]',
  frame_eclipse: 'ring-4 ring-[#f0c75e] shadow-[0_0_36px_-2px_rgb(240_199_94_/_0.75)]',
};

export const frameRing = (frame: string | null | undefined) => (frame == null ? '' : (FRAMES[frame] ?? ''));

/** Puts the chosen colour theme on the page; none for the app's own. */
export function useTheme(theme: string | null | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme != null && itemById(theme)?.kind === 'theme') root.dataset.accent = theme;
    else delete root.dataset.accent;
  }, [theme]);
}
