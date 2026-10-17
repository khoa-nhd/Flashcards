/**
 * Everything the thinking indicator says and the emoji it may wear.
 *
 * The content is authored in three layers:
 * - `TARGETS` are shared phrase endings ("the dictionary"), each tagged with
 *   topic buckets; every persona brings its own 20 `openers` that read
 *   naturally in front of any target.
 * - Stage lines fire by elapsed time while the assistant waits: reading,
 *   searching, composing, then still going.
 * - Trivia lines are framing plus fact, composed per persona at render time,
 *   so one fact is told in three voices.
 *
 * Bucket ids are the tag vocabulary: every opener, target and stage line
 * carries 2 to 4 of them, and the emoji appended to a line is drawn from its
 * tags' buckets (see thinking-engine.ts). Trivia never wears emoji.
 */

export type PersonaId = 'librarian' | 'noir' | 'grad';
export type StageId = 'reading' | 'searching' | 'composing' | 'still';

export interface TaggedLine {
  text: string;
  /** Bucket ids from EMOJI_BUCKETS that fit this line. */
  tags: string[];
}

export interface PersonaContent {
  label: string;
  openers: TaggedLine[];
  stages: Record<StageId, TaggedLine[]>;
}

/** The stage ladder, in order; thresholds live in thinking-engine.ts. */
export const STAGE_ORDER: StageId[] = ['reading', 'searching', 'composing', 'still'];

/** Emoji that never appear, however the pools change. */
export const EMOJI_DENYLIST: string[] = ['🍆', '🍑', '🥒', '💩', '🚽', '🧻', '🩲', '🩸', '🖕', '🔞', '🚬'];

/**
 * Hand-picked emoji per topic. Used for emoji appended to phrase and stage
 * lines (matched through the line's tags) and nothing else; lone-emoji ticks
 * draw from the full generated pool instead.
 */
export const EMOJI_BUCKETS: Record<string, string[]> = {
  books: ['📚', '📖', '📕', '📗', '📘', '📙', '📔', '📓', '📒', '🔖', '🗂️', '📑', '🗞️', '📰'],
  detective: ['🕵️', '🔍', '🔎', '🗝️', '🔦', '🧩', '🪪', '🎩', '🕶️'],
  noir: ['🌃', '🌉', '🎷', '🖤', '🧥', '🥃', '🌆'],
  caffeine: ['☕', '🫖', '🍵', '🧉', '⚡', '🥱', '🍫'],
  lab: ['🧪', '⚗️', '🔬', '🧬', '🧫', '📡', '🧲', '📊', '📉'],
  words: ['🔤', '💬', '🗨️', '📝', '✍️', '🗯️', '📢'],
  cards: ['🃏', '🎴', '📇', '🗃️', '🎲'],
  ink: ['🖋️', '🖊️', '📜', '⌨️', '🖨️', '📄', '📃'],
  time: ['⏳', '⌛', '🕰️', '⏰', '🕐', '🗓️', '📅'],
  progress: ['📈', '⏱️', '✅', '🏁', '🎯', '🚩', '🏆'],
  thoughts: ['💭', '💡', '🧠', '🤔', '🧐', '🌀'],
  sparkles: ['✨', '🌟', '💫', '⭐', '🌠', '🔆'],
  nature: ['🌱', '🌿', '🍀', '🌵', '🌳', '🌲', '🍃', '🌾', '🌸', '🍁', '🐚'],
  space: ['🚀', '🛰️', '🌌', '🌙', '🪐', '☄️', '🔭', '🌍', '🛸'],
  animals: ['🐾', '🦊', '🐻', '🐼', '🦉', '🐈', '🐢', '🐿️', '🦔', '🐙', '🦋'],
  snacks: ['🍪', '🍩', '🥐', '🧁', '🍕', '🍜', '🍎', '🍇', '🥪'],
  art: ['🎨', '🖌️', '🖼️', '🎭', '🎬', '🩰'],
  music: ['🎵', '🎶', '🎼', '🎺', '🥁', '🎤', '🎹'],
  night: ['😴', '💤', '🌜', '🦇', '🌛'],
  effort: ['💪', '⚙️', '🛠️', '🐝', '🧗', '🏋️'],
};

/** Phrase endings, shared by every persona. */
export const TARGETS: TaggedLine[] = [
  { text: 'the dictionary', tags: ['books', 'words'] },
  { text: 'the thesaurus', tags: ['words', 'books'] },
  { text: 'the word bank', tags: ['words', 'books'] },
  { text: 'your flashcards', tags: ['cards', 'books'] },
  { text: 'the etymology files', tags: ['ink', 'detective'] },
  { text: 'the index', tags: ['books', 'detective'] },
  { text: 'the card catalog', tags: ['cards', 'books'] },
  { text: 'the archives', tags: ['books', 'detective'] },
  { text: 'my notes on your words', tags: ['words', 'ink'] },
  { text: 'your vocabulary list', tags: ['words', 'cards'] },
  { text: 'the glossary', tags: ['books', 'words'] },
  { text: 'the lexicon', tags: ['words', 'books'] },
  { text: 'the stacks', tags: ['books', 'time'] },
  { text: 'the reference shelf', tags: ['books', 'time'] },
  { text: 'your saved words', tags: ['words', 'sparkles'] },
  { text: 'the quote files', tags: ['ink', 'words'] },
  { text: 'the examples', tags: ['words', 'sparkles'] },
  { text: 'the translations', tags: ['words', 'thoughts'] },
  { text: 'your practice history', tags: ['time', 'progress'] },
  { text: 'the idiom files', tags: ['ink', 'detective'] },
  { text: 'the pronunciation guide', tags: ['words', 'music'] },
  { text: 'the phrase book', tags: ['books', 'words'] },
  { text: 'the marginalia', tags: ['ink', 'art'] },
  { text: 'your word of the day', tags: ['time', 'sparkles'] },
];

export const PERSONAS: Record<PersonaId, PersonaContent> = {
  librarian: {
    label: 'The Librarian',
    openers: [
      { text: 'Consulting', tags: ['thoughts', 'books'] },
      { text: 'Rereading', tags: ['books', 'time'] },
      { text: 'Cataloging', tags: ['cards', 'books'] },
      { text: 'Shelving', tags: ['books', 'effort'] },
      { text: 'Flipping through', tags: ['books', 'cards'] },
      { text: 'Cross-referencing', tags: ['detective', 'books'] },
      { text: 'Dusting off', tags: ['books', 'effort'] },
      { text: 'Bookmarking', tags: ['books', 'time'] },
      { text: 'Annotating', tags: ['ink', 'words'] },
      { text: 'Whispering to', tags: ['thoughts', 'books'] },
      { text: 'Unfolding', tags: ['books', 'sparkles'] },
      { text: 'Decoding', tags: ['detective', 'words'] },
      { text: 'Filing', tags: ['cards', 'effort'] },
      { text: 'Borrowing', tags: ['books', 'time'] },
      { text: 'Stamping', tags: ['cards', 'ink'] },
      { text: 'Indexing', tags: ['cards', 'books'] },
      { text: 'Preserving', tags: ['books', 'effort'] },
      { text: 'Reciting', tags: ['words', 'thoughts'] },
      { text: 'Skimming', tags: ['books', 'time'] },
      { text: 'Curating', tags: ['art', 'books'] },
    ],
    stages: {
      reading: [
        { text: 'Unwrapping the question…', tags: ['thoughts', 'sparkles'] },
        { text: 'Reading the first line closely…', tags: ['books', 'time'] },
        { text: 'Marking the right page…', tags: ['books', 'ink'] },
        { text: 'Opening to the right chapter…', tags: ['books', 'time'] },
        { text: 'Listening to your question…', tags: ['words', 'music'] },
      ],
      searching: [
        { text: 'Searching the shelves…', tags: ['books', 'time'] },
        { text: 'Walking the stacks…', tags: ['books', 'nature'] },
        { text: 'Checking the card catalog…', tags: ['cards', 'books'] },
        { text: 'Hunting for the right volume…', tags: ['books', 'effort'] },
        { text: 'Consulting the index…', tags: ['books', 'cards'] },
      ],
      composing: [
        { text: 'Composing a careful answer…', tags: ['words', 'art'] },
        { text: 'Writing in pencil, editing in ink…', tags: ['ink', 'art'] },
        { text: 'Drafting the reply…', tags: ['ink', 'words'] },
        { text: 'Choosing the right words…', tags: ['words', 'sparkles'] },
        { text: 'Setting the type…', tags: ['ink', 'effort'] },
      ],
      still: [
        { text: 'Still reading closely — worth it…', tags: ['books', 'time'] },
        { text: 'Good answers need their time…', tags: ['time', 'sparkles'] },
        { text: 'Almost there — turning the page…', tags: ['books', 'progress'] },
        { text: 'Still with you — carefully…', tags: ['thoughts', 'sparkles'] },
        { text: 'Deep in the stacks — back soon…', tags: ['books', 'night'] },
      ],
    },
  },
  noir: {
    label: 'The Noir Detective',
    openers: [
      { text: 'Interrogating', tags: ['detective', 'words'] },
      { text: 'Staking out', tags: ['detective', 'night'] },
      { text: 'Tailing', tags: ['detective', 'night'] },
      { text: 'Wiretapping', tags: ['detective', 'music'] },
      { text: 'Cross-examining', tags: ['detective', 'words'] },
      { text: 'Casing', tags: ['detective', 'night'] },
      { text: 'Bugging', tags: ['detective', 'lab'] },
      { text: 'Surveilling', tags: ['detective', 'night'] },
      { text: 'Shaking down', tags: ['detective', 'effort'] },
      { text: 'Unlocking', tags: ['detective', 'thoughts'] },
      { text: 'Prying open', tags: ['detective', 'effort'] },
      { text: 'Reconstructing', tags: ['detective', 'thoughts'] },
      { text: 'Piecing together', tags: ['detective', 'thoughts'] },
      { text: 'Tracking', tags: ['detective', 'nature'] },
      { text: 'Confiscating', tags: ['detective', 'ink'] },
      { text: 'Sketching', tags: ['art', 'detective'] },
      { text: 'Examining', tags: ['detective', 'lab'] },
      { text: 'Sifting', tags: ['detective', 'time'] },
      { text: 'Verifying', tags: ['progress', 'detective'] },
      { text: 'Keeping an eye on', tags: ['detective', 'night'] },
    ],
    stages: {
      reading: [
        { text: 'Reading the brief…', tags: ['detective', 'ink'] },
        { text: 'Taking in the details…', tags: ['detective', 'thoughts'] },
        { text: 'Sizing up the question…', tags: ['detective', 'thoughts'] },
        { text: 'Scanning the note…', tags: ['detective', 'ink'] },
        { text: 'Lighting the desk lamp…', tags: ['noir', 'night'] },
      ],
      searching: [
        { text: 'Following the leads…', tags: ['detective', 'effort'] },
        { text: 'Checking the usual suspects…', tags: ['detective', 'thoughts'] },
        { text: 'Working the case…', tags: ['detective', 'time'] },
        { text: 'Shaking down the thesaurus…', tags: ['detective', 'words'] },
        { text: 'Pulling the file…', tags: ['detective', 'ink'] },
      ],
      composing: [
        { text: 'Writing up the report…', tags: ['ink', 'detective'] },
        { text: 'Typing the findings…', tags: ['ink', 'progress'] },
        { text: 'Drafting the statement…', tags: ['ink', 'detective'] },
        { text: 'Putting the pieces together…', tags: ['thoughts', 'effort'] },
        { text: 'Rounding up the words…', tags: ['words', 'detective'] },
      ],
      still: [
        { text: 'This one needs a moment…', tags: ['time', 'thoughts'] },
        { text: 'Still on the case…', tags: ['detective', 'time'] },
        { text: 'Almost cracked it…', tags: ['detective', 'progress'] },
        { text: 'Following the last lead…', tags: ['detective', 'effort'] },
        { text: 'Good leads take time…', tags: ['time', 'detective'] },
      ],
    },
  },
  grad: {
    label: 'The Caffeinated Grad Student',
    openers: [
      { text: 'Speed-reading', tags: ['books', 'caffeine'] },
      { text: 'Cramming', tags: ['books', 'caffeine'] },
      { text: 'Highlighting', tags: ['ink', 'words'] },
      { text: 'Re-tabbing', tags: ['cards', 'ink'] },
      { text: 'Structuring', tags: ['thoughts', 'progress'] },
      { text: 'Experimenting on', tags: ['lab', 'thoughts'] },
      { text: 'Stress-testing', tags: ['lab', 'progress'] },
      { text: 'Diagramming', tags: ['art', 'thoughts'] },
      { text: 'Rehearsing', tags: ['music', 'words'] },
      { text: 'Memorizing', tags: ['thoughts', 'cards'] },
      { text: 'Brainstorming', tags: ['thoughts', 'sparkles'] },
      { text: 'Validating', tags: ['lab', 'progress'] },
      { text: 'Running stats on', tags: ['lab', 'time'] },
      { text: 'Simulating', tags: ['lab', 'thoughts'] },
      { text: 'Formatting', tags: ['ink', 'time'] },
      { text: 'Warming up', tags: ['caffeine', 'effort'] },
      { text: 'Overthinking', tags: ['thoughts', 'night'] },
      { text: 'Underlining', tags: ['ink', 'books'] },
      { text: 'Grinding through', tags: ['effort', 'cards'] },
      { text: 'Rewriting', tags: ['ink', 'words'] },
    ],
    stages: {
      reading: [
        { text: 'Reading the prompt…', tags: ['words', 'time'] },
        { text: 'Parsing the question…', tags: ['lab', 'words'] },
        { text: 'Highlighting the key terms…', tags: ['ink', 'words'] },
        { text: 'Flipping to a blank page…', tags: ['books', 'ink'] },
        { text: 'Sipping first, reading second…', tags: ['caffeine', 'words'] },
      ],
      searching: [
        { text: 'Digging through my notes…', tags: ['ink', 'effort'] },
        { text: 'Running a quick search…', tags: ['lab', 'progress'] },
        { text: 'Checking three tabs at once…', tags: ['cards', 'caffeine'] },
        { text: 'Skimming the literature…', tags: ['books', 'caffeine'] },
        { text: 'Refreshing the page…', tags: ['time', 'progress'] },
      ],
      composing: [
        { text: 'Assembling the answer…', tags: ['thoughts', 'effort'] },
        { text: 'Wrangling the paragraphs…', tags: ['words', 'effort'] },
        { text: 'Formatting the response…', tags: ['ink', 'time'] },
        { text: 'Turning notes into sentences…', tags: ['ink', 'words'] },
        { text: 'Almost ready, one coffee later…', tags: ['caffeine', 'progress'] },
      ],
      still: [
        { text: 'Still at it — deep focus…', tags: ['effort', 'thoughts'] },
        { text: 'The coffee is working…', tags: ['caffeine', 'progress'] },
        { text: 'Big answer, almost done…', tags: ['progress', 'time'] },
        { text: 'Two tabs left to close…', tags: ['cards', 'progress'] },
        { text: 'Processing… seriously…', tags: ['lab', 'time'] },
      ],
    },
  },
};

/**
 * True, well-known word origins. Each fact stays short so that any framing
 * plus fact stays within TRIVIA_MAX_WORDS (20) — the test suite proves it.
 */
export const TRIVIA_FACTS: string[] = [
  '“Nice” once meant foolish — from Latin nescius, ignorant.',
  'The sandwich honors the Earl of Sandwich, who ate meat between bread while gambling.',
  'Muscle comes from Latin musculus, “little mouse” — muscles looked like mice.',
  'Capital comes from Latin caput — “head”, as in a headcount of cattle.',
  'Quarantine comes from Italian quaranta giorni — forty days of ship isolation.',
  'Window comes from Old Norse vindauga — literally “wind eye”.',
  'Robot comes from Czech robota, meaning forced labor.',
  'In “nightmare”, the “mare” was a spirit said to sit on sleeping chests.',
  'Bankrupt comes from Italian banca rotta — a broken bench.',
  'Quixotic comes from Don Quixote, literature’s most famous dreamer.',
  'Mentor comes from Mentor, a character in Homer’s Odyssey.',
  'Clue was once “clew” — a ball of thread through a maze.',
  'Companion: Latin com plus panis — someone you share bread with.',
  'Disaster comes from Italian disastro — ill-starred, blamed on bad stars.',
  'Electric comes from Greek elektron, amber — rubbed amber attracted objects.',
  'Vaccine comes from vacca, Latin for cow — via cowpox.',
  'Whiskey comes from Gaelic uisce beatha — “water of life”.',
  'Malaria comes from Italian mala aria — “bad air”.',
  'Algebra comes from Arabic al-jabr — reunion of broken parts.',
  'Shampoo comes from Hindi chāmpo, to press and massage.',
  'Bedlam comes from Bethlehem, a notorious London asylum.',
  'Trivia comes from Latin trivium — a crossroads, where idle talk happened.',
  'Quiz has no known origin — etymologists genuinely can’t agree.',
  'Bully once meant sweetheart — like calling someone “my bully”.',
  'Awful once meant “full of awe”, not bad at all.',
  'Girl once meant a young person of any sex.',
  'Computer once meant a person who did calculations.',
  'Lunatic comes from Luna — the moon was blamed for madness.',
  'Camera comes from Latin camera — “room”, as in camera obscura.',
  'Sarcasm comes from Greek sarkazein — “to tear flesh”.',
];

/** How each persona opens a trivia line; picked per tick. */
export const TRIVIA_FRAMINGS: Record<PersonaId, string[]> = {
  librarian: ['From the archives:', 'Shelf note:', 'The card catalog says:', 'Marginalia:'],
  noir: ['For the record:', 'Case file:', 'Between us:', 'Notebook says:'],
  grad: ['Fun fact:', 'Lecture notes:', 'Overheard in the lab:', 'From my notes:'],
};
