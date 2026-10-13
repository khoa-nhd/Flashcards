/**
 * Simplified true mastery calculation for client-side use.
 * Only uses data available in VocabularyEntry: mastery, reviewDate, reviewStatus.
 */

/**
 * Compute a simplified true mastery based on data available in VocabularyEntry.
 * 
 * Adjustments:
 * - Overdue penalty: -0.5 per day overdue (max -2.0)
 * - No review date penalty: -1.0 (if not mastered)
 * - Overdue status: -0.5
 * - Due today: -0.2
 * 
 * Total adjustment clamped to [-2.0, 0] (only penalties in this simplified version).
 */

/** Input for simplified true mastery calculation */
export interface SimpleTrueMasteryInput {
  mastery: number | null;
  reviewDate: string | null;
  reviewStatus: string;
}

/** Result of simplified true mastery calculation */
export interface SimpleTrueMasteryResult {
  mastery: number;
  tier: 'Mastered' | 'Strong' | 'Good' | 'Learning' | 'Weak' | 'New';
  adjustment: number;
}

/**
 * Compute a simplified true mastery based on data available in VocabularyEntry.
 * 
 * @param input - Entry data and today's date
 * @returns True mastery result with mastery score, tier, and adjustment
 */
export function computeSimpleTrueMastery(input: {
  entry: { mastery: number | null; reviewDate: string | null; reviewStatus: string };
  today: string;
}): { mastery: number; tier: string; adjustment: number } {
  const baseMastery = input.entry.mastery ?? 0;
  
  // Special cases
  if (input.entry.reviewStatus === 'mastered' || baseMastery >= 10) {
    return { mastery: 10, tier: 'Mastered', adjustment: 0 };
  }
  if (baseMastery === 0) {
    return { mastery: 0, tier: 'New', adjustment: 0 };
  }
  
  let adjustment = 0;
  
  // Overdue penalty: -0.5 per day overdue, max -2.0
  if (input.entry.reviewDate) {
    const todayDate = new Date(input.today);
    const dueDate = new Date(input.entry.reviewDate);
    const daysOverdue = Math.floor((todayDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysOverdue > 0) {
      adjustment -= Math.min(2.0, daysOverdue * 0.5);
    }
  } else if (input.entry.mastery !== null && input.entry.mastery < 10) {
    // No review date but not mastered - scheduling gap
    adjustment -= 1.0;
  }
  
  // Review status modifiers
  if (input.entry.reviewStatus === 'overdue') {
    adjustment -= 0.5;
  } else if (input.entry.reviewStatus === 'due_today') {
    adjustment -= 0.2;
  }
  
  // Clamp adjustment to [-2.0, 0]
  adjustment = Math.max(-2.0, Math.min(0, adjustment));
  
  const finalMastery = Math.max(0, Math.min(10, baseMastery + adjustment));
  
  return {
    mastery: Math.round(finalMastery * 10) / 10,
    tier: getTrueMasteryTier(finalMastery),
    adjustment: Math.round(adjustment * 10) / 10,
  };
}

/**
 * Get the tier label for a true mastery score.
 */
export function getTrueMasteryTier(mastery: number): 'Mastered' | 'Strong' | 'Good' | 'Learning' | 'Weak' | 'New' {
  if (mastery >= 9) return 'Mastered';
  if (mastery >= 7.5) return 'Strong';
  if (mastery >= 6) return 'Good';
  if (mastery >= 4) return 'Learning';
  if (mastery >= 2) return 'Weak';
  return 'New';
}