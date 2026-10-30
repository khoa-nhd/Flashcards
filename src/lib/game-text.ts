/**
 * What the game's parts are called, in both languages: quests, badges, their
 * tiers and the rewards waiting to be claimed.
 */
import { itemById } from '../../shared/gamification/catalog.js';
import type { GameQuestView, GameRewardView } from '../../shared/api.js';
import { pick, type UiLanguage } from './i18n.js';

/** A quest as a short instruction, its target in it. */
export function questText(language: UiLanguage, quest: Pick<GameQuestView, 'kind' | 'target'>): string {
  const n = quest.target;
  switch (quest.kind) {
    case 'due_reviews':
      return pick(language, `Review ${n} due words`, `Ôn ${n} từ đến hạn`);
    case 'new_words':
      return pick(language, `Learn ${n} new ${n === 1 ? 'word' : 'words'}`, `Học ${n} từ mới`);
    case 'practice':
      return pick(language, `Practise ${n} times`, `Luyện tập ${n} lượt`);
    case 'listening':
      return pick(language, `Do ${n} listening questions`, `Luyện nghe ${n} câu`);
    case 'extra_reviews':
      return pick(language, `Review ${n} extra words (early or at random)`, `Ôn thêm ${n} từ (ôn sớm hoặc ngẫu nhiên)`);
    case 'added_words':
      return pick(language, `Add ${n} new ${n === 1 ? 'word' : 'words'}`, `Thêm ${n} từ mới`);
    case 'combo':
      return pick(language, `Reach a combo of ${n}`, `Đạt combo ${n}`);
    case 'minutes':
      return pick(language, `Study for ${Math.round(n / 60)} minutes`, `Học ${Math.round(n / 60)} phút`);
    case 'goal':
      return pick(language, 'Meet all of today’s goals', 'Đạt đủ mục tiêu hôm nay');
    case 'week_reviews':
      return pick(language, `Review ${n} times this week`, `Ôn ${n} lượt trong tuần`);
    case 'week_goal_days':
      return pick(language, `Meet your goals on ${n} days this week`, `Đạt mục tiêu ${n} ngày trong tuần`);
    case 'week_mastered':
      return pick(language, `Take ${n} words to Master this week`, `Đưa ${n} từ lên Master trong tuần`);
    case 'week_practice':
      return pick(language, `Practise ${n} times this week`, `Luyện tập ${n} lượt trong tuần`);
    default:
      return quest.kind;
  }
}

/** A quest's progress as it reads best: minutes for the time quest, a count for the rest. */
export function questProgress(quest: Pick<GameQuestView, 'kind' | 'target' | 'progress'>): string {
  if (quest.kind === 'minutes') return `${Math.floor(quest.progress / 60)}/${Math.round(quest.target / 60)}`;
  return `${quest.progress}/${quest.target}`;
}

export function badgeName(language: UiLanguage, badge: string): string {
  switch (badge) {
    case 'words_studied':
      return pick(language, 'Word collector', 'Nhà sưu tầm từ');
    case 'mastered':
      return pick(language, 'Master', 'Bậc thầy');
    case 'reviews':
      return pick(language, 'Reviewer', 'Chăm ôn');
    case 'practice':
      return pick(language, 'Practitioner', 'Luyện công');
    case 'streak':
      return pick(language, 'Steady', 'Bền bỉ');
    case 'hours':
      return pick(language, 'Hours in', 'Giờ học');
    case 'night_owl':
      return pick(language, 'Night owl', 'Cú đêm');
    case 'combo':
      return pick(language, 'Combo', 'Combo');
    case 'boss':
      return pick(language, 'Boss slayer', 'Diệt boss');
    default: {
      // A month's challenge: month_2026_10.
      const month = /^month_(\d{4})_(\d{2})$/.exec(badge);
      if (month !== null) return pick(language, `Challenge of ${month[2]}/${month[1]}`, `Thử thách tháng ${Number(month[2])}/${month[1]}`);
      return badge;
    }
  }
}

/** What a badge counts, with its next threshold. */
export function badgeMeasure(language: UiLanguage, badge: string, threshold: number): string {
  switch (badge) {
    case 'words_studied':
      return pick(language, `${threshold} words studied`, `Học ${threshold} từ`);
    case 'mastered':
      return pick(language, `${threshold} words at Master`, `${threshold} từ ở mức Master`);
    case 'reviews':
      return pick(language, `${threshold} reviews`, `${threshold} lượt ôn`);
    case 'practice':
      return pick(language, `${threshold} practice answers`, `${threshold} lượt luyện tập`);
    case 'streak':
      return pick(language, `A ${threshold}-day streak`, `Chuỗi ${threshold} ngày`);
    case 'hours':
      return pick(language, `${threshold} ${threshold === 1 ? 'hour' : 'hours'} answering`, `${threshold} giờ trả lời`);
    case 'night_owl':
      return pick(language, `${threshold} answers after 11 pm`, `${threshold} lượt sau 23 giờ`);
    case 'combo':
      return pick(language, `A combo of ${threshold}`, `Combo ${threshold}`);
    case 'boss':
      return pick(language, `${threshold} weekly ${threshold === 1 ? 'boss' : 'bosses'} beaten`, `Hạ ${threshold} boss tuần`);
    default:
      return String(threshold);
  }
}

export function tierName(language: UiLanguage, tier: number): string {
  const names: Array<[string, string]> = [
    ['Bronze', 'Đồng'],
    ['Silver', 'Bạc'],
    ['Gold', 'Vàng'],
    ['Diamond', 'Kim cương'],
    ['Legend', 'Huyền thoại'],
  ];
  const [en, vi] = names[Math.min(names.length, Math.max(1, tier)) - 1]!;
  return pick(language, en, vi);
}

/** A reward waiting to be claimed: a title and a line saying what it is. */
export function rewardText(language: UiLanguage, reward: GameRewardView): { title: string; detail: string } {
  const payload = reward.payload;
  const xp = typeof payload.xp === 'number' ? payload.xp : 0;
  const plus = xp > 0 ? ` · +${xp} XP` : '';
  switch (reward.kind) {
    case 'level':
      return {
        title: pick(language, `Level ${String(payload.level)}`, `Level ${String(payload.level)}`),
        detail: pick(language, 'A new level reached.', 'Bạn đã lên level mới.'),
      };
    case 'badge':
      return {
        title: `${badgeName(language, String(payload.badge))} · ${tierName(language, Number(payload.tier))}`,
        detail: pick(language, 'A new badge.', 'Huy hiệu mới.'),
      };
    case 'quest':
      return {
        title: questText(language, { kind: String(payload.quest), target: Number(payload.target) }),
        detail: pick(language, `Quest complete${plus}`, `Hoàn thành nhiệm vụ${plus}`),
      };
    case 'quests_all':
      return {
        title: pick(language, 'All three quests done', 'Xong cả ba nhiệm vụ'),
        detail: pick(language, `Today’s quests are complete${plus}`, `Hoàn thành mọi nhiệm vụ hôm nay${plus}`),
      };
    case 'checkin':
      if (payload.chest === 'rare') {
        return {
          title: pick(language, 'Check-in · day 7 of 7', 'Điểm danh · ngày 7/7'),
          detail: pick(language, 'A full week of study: a rare chest.', 'Học trọn một tuần: một rương hiếm.'),
        };
      }
      return {
        title: pick(language, `Check-in · day ${String(payload.day)} of 7`, `Điểm danh · ngày ${String(payload.day)}/7`),
        detail: pick(language, `For studying today${plus}`, `Vì hôm nay đã học${plus}`),
      };
    case 'freeze_granted':
      return {
        title: pick(language, 'A streak freeze', 'Một lần đóng băng streak'),
        detail: pick(
          language,
          `For a ${String(payload.streak)}-day streak. It keeps the streak if you miss a day.`,
          `Cho chuỗi ${String(payload.streak)} ngày. Nó giữ chuỗi nếu bạn lỡ một ngày.`,
        ),
      };
    case 'freeze_used': {
      const days = Array.isArray(payload.days) ? payload.days.length : 1;
      return {
        title: pick(language, 'Your streak was kept', 'Chuỗi ngày được giữ lại'),
        detail: pick(
          language,
          `${days} ${days === 1 ? 'freeze covered a missed day' : 'freezes covered missed days'}.`,
          `${days} lần đóng băng đã che ngày bị lỡ.`,
        ),
      };
    }
    case 'comeback':
      return {
        title: pick(language, 'Welcome back', 'Chào mừng trở lại'),
        detail: pick(language, 'Double XP for the next 24 hours.', 'Nhân đôi XP trong 24 giờ tới.'),
      };
    case 'league': {
      const rank = Number(payload.rank);
      const league = leagueName(language, Number(payload.tier));
      if (payload.outcome === 'up') {
        return {
          title: pick(language, `Up to ${league}`, `Lên hạng ${league}`),
          detail: pick(language, `You finished the week #${rank} in your league.`, `Bạn kết thúc tuần ở hạng ${rank} trong nhóm.`),
        };
      }
      if (payload.outcome === 'down') {
        return {
          title: pick(language, `Down to ${league}`, `Xuống hạng ${league}`),
          detail: pick(language, `You finished the week #${rank}. A new week, a new chance.`, `Bạn kết thúc tuần ở hạng ${rank}. Tuần mới, cơ hội mới.`),
        };
      }
      return {
        title: pick(language, `Staying in ${league}`, `Giữ hạng ${league}`),
        detail: pick(language, `You finished the week #${rank} in your league.`, `Bạn kết thúc tuần ở hạng ${rank} trong nhóm.`),
      };
    }
    case 'chest':
      return {
        title: chestName(language, typeof payload.rarity === 'string' ? payload.rarity : 'common'),
        detail: pick(language, 'For meeting your goals. Open it to see what is inside.', 'Vì đã đạt mục tiêu. Mở ra xem bên trong có gì.'),
      };
    case 'boss':
      return {
        title: pick(language, 'The weekly boss is beaten', 'Đã hạ boss tuần'),
        detail: pick(language, `+${String(payload.stardust ?? 0)} stardust${plus}`, `+${String(payload.stardust ?? 0)} bụi sao${plus}`),
      };
    case 'set':
      return {
        title: pick(language, 'A set completed', 'Hoàn thành một bộ sưu tập'),
        detail: pick(
          language,
          `+${String(payload.stardust ?? 0)} stardust and the title ${itemName(language, String(payload.title))}.`,
          `+${String(payload.stardust ?? 0)} bụi sao và danh hiệu ${itemName(language, String(payload.title))}.`,
        ),
      };
    case 'challenge': {
      const against = typeof payload.against === 'string' ? payload.against : pick(language, 'a friend', 'một người bạn');
      if (payload.outcome === 'won') {
        return {
          title: pick(language, `You beat ${against}`, `Bạn thắng ${against}`),
          detail: pick(language, `Weekly challenge won${plus}`, `Thắng thách đấu tuần${plus}`),
        };
      }
      return {
        title: pick(language, `A draw with ${against}`, `Hòa với ${against}`),
        detail: pick(language, `Weekly challenge drawn${plus}`, `Thách đấu tuần hòa${plus}`),
      };
    }
  }
}

/** A chest's name, by how rare it is. */
export function chestName(language: UiLanguage, rarity: string): string {
  if (rarity === 'legendary') return pick(language, 'Legendary chest', 'Rương huyền thoại');
  if (rarity === 'rare') return pick(language, 'Rare chest', 'Rương hiếm');
  return pick(language, 'Chest', 'Rương');
}

/** An item's name from the catalogue. */
export function itemName(language: UiLanguage, id: string): string {
  const item = itemById(id);
  return item === undefined ? id : pick(language, item.en, item.vi);
}

/** A rarity's name. */
export function rarityName(language: UiLanguage, rarity: string): string {
  switch (rarity) {
    case 'legendary':
      return pick(language, 'Legendary', 'Huyền thoại');
    case 'epic':
      return pick(language, 'Epic', 'Sử thi');
    case 'rare':
      return pick(language, 'Rare', 'Hiếm');
    default:
      return pick(language, 'Common', 'Thường');
  }
}

/** A league tier's name: Bronze at 1 up to Star at 8. */
export function leagueName(language: UiLanguage, tier: number): string {
  const names: Array<[string, string]> = [
    ['Bronze', 'Đồng'],
    ['Silver', 'Bạc'],
    ['Gold', 'Vàng'],
    ['Platinum', 'Bạch kim'],
    ['Jade', 'Ngọc'],
    ['Diamond', 'Kim cương'],
    ['Moon', 'Trăng'],
    ['Star', 'Sao'],
  ];
  const [en, vi] = names[Math.min(names.length, Math.max(1, tier)) - 1]!;
  return pick(language, en, vi);
}
