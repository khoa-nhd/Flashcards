/**
 * Proves the variety claim: counts every distinct string the thinking engine
 * can render — phrased lines with each of their tagged emoji, stage lines,
 * trivia lines in three voices, and the lone-emoji pool — then replays ten
 * simulated waits so the mix can be eyeballed.
 *
 *   npm run thinking:variety
 */
import { EMOJI_BUCKETS, PERSONAS, STAGE_ORDER, TARGETS, TRIVIA_FACTS, TRIVIA_FRAMINGS } from '../src/lib/thinking-content.js';
import { EMOJI_POOL } from '../src/lib/emoji-pool.generated.js';
import { createThinkingSession, expandEmojiChoices, type ThinkingMemory } from '../src/lib/thinking-engine.js';

let phraseBase = 0;
let phraseRenders = 0;
for (const persona of Object.values(PERSONAS)) {
  for (const opener of persona.openers) {
    for (const target of TARGETS) {
      phraseBase++;
      phraseRenders += 1 + expandEmojiChoices([...opener.tags, ...target.tags]).length;
    }
  }
}

let stageBase = 0;
let stageRenders = 0;
for (const persona of Object.values(PERSONAS)) {
  for (const stage of STAGE_ORDER) {
    for (const line of persona.stages[stage]) {
      stageBase++;
      stageRenders += 1 + expandEmojiChoices(line.tags).length;
    }
  }
}

const triviaRenders = Object.keys(PERSONAS).length * TRIVIA_FACTS.length * Object.values(TRIVIA_FRAMINGS)[0]!.length;
const loneEmoji = EMOJI_POOL.length;
const total = phraseRenders + stageRenders + triviaRenders + loneEmoji;

console.log('Distinct renderable strings');
console.log(`  phrased lines: ${phraseBase} base × tagged emoji = ${phraseRenders}`);
console.log(`  stage lines:   ${stageBase} base × tagged emoji = ${stageRenders}`);
console.log(`  trivia lines:  ${TRIVIA_FACTS.length} facts × 4 framings × 3 voices = ${triviaRenders}`);
console.log(`  lone emoji:    ${loneEmoji}`);
console.log(`  TOTAL:         ${total}`);
console.log(`  tagged emoji buckets: ${Object.values(EMOJI_BUCKETS).flat().length} across ${Object.keys(EMOJI_BUCKETS).length} buckets`);
console.log('');

console.log('Ten simulated waits (fresh session memory each):');
for (let seed = 1; seed <= 10; seed++) {
  const memory: ThinkingMemory = { recent: [], lastFlavor: null, lastPersona: null };
  const session = createThinkingSession({ seed, memory });
  const first = session.at(2500);
  console.log(`  ${String(seed).padStart(2)}  ${session.flavor.padEnd(7)} ${session.persona.padEnd(9)} ${first.kind.padEnd(6)} ${first.text}${first.emoji ? ` ${first.emoji}` : ''}`);
}
