/**
 * Reads the four flashcard fields out of a Vocabulary Expert reply.
 *
 * The replies follow the pinned Markdown format (see SYSTEM_PROMPTS), but a
 * model may drift, so this parser is tolerant: the first bold heading is the
 * word, the labelled sections give the meaning and the definition, and the
 * first example's English sentence is the example. Anything it cannot find
 * with confidence is left empty for the reader to fill in — never guessed at,
 * truncated or combined.
 */

export type ExtractedField = 'word' | 'meaning' | 'definition' | 'example';

export type ExampleRegister = 'simple' | 'more_academic' | 'super_academic';

export interface ExtractedExample {
  register: ExampleRegister;
  /** Display label: "Simple", "More academic" or "Super academic". */
  label: string;
  /** The English sentence only, translation dropped. */
  sentence: string;
}

export interface ExtractedAnalysis {
  word: string;
  meaning: string;
  definition: string;
  example: string;
  /** The three register-labelled examples parsed from the reply, when present. */
  examples: ExtractedExample[];
  /** The fields the reply did not carry, for the notice above the form. */
  missing: ExtractedField[];
}

/** Letters only Vietnamese words have, used to tell a translation from the sentence it follows. */
const VIETNAMESE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

/** Where a heading line stops being the word: the separators the format puts after it. */
const HEADING_SEPARATORS = ['·', '•', '|', ' — ', ' – ', ' - ', ' (', '/'];

/** A list item: a bullet or a number. */
const BULLET = /^(?:[-*•]|\d+[.)])\s+(.*)$/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Removes emphasis markers, which the flashcard fields do not render. */
const stripEmphasis = (text: string) => text.replace(/\*\*/g, '').replace(/^[*_]+|[*_]+$/g, '').trim();

/** Removes matching bookend quotes, which a model sometimes adds around a word. */
const unquote = (text: string) => {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ['‘', '’'],
    ["'", "'"],
  ];
  let result = text.trim();
  for (const [open, close] of pairs) {
    if (result.length > 1 && result.startsWith(open) && result.endsWith(close)) result = result.slice(1, -1).trim();
  }
  return result;
};

/** One field's worth of plain text: no Markdown markers, no wrapping quotes. */
const plainText = (text: string) => unquote(stripEmphasis(tidy(text)));

// ---- The word ---------------------------------------------------------------

function plausibleWord(candidate: string): boolean {
  if (candidate === '' || candidate.length > 60) return false;
  // A sentence, not a word.
  if (/[.!?:;,]$/.test(candidate)) return false;
  if (candidate.split(' ').length > 6) return false;
  return true;
}

function extractWord(lines: string[]): string {
  // The heading is bold, and usually within the first couple of lines. A bold
  // label ("**Definition:** …") never counts: it is a section, not the word.
  for (const line of lines.slice(0, 3)) {
    const bold = /\*\*(.+?)\*\*/.exec(line);
    if (bold === null) continue;
    const candidate = unquote(stripEmphasis(bold[1]!)).replace(/:\s*$/, '').trim();
    if (candidate !== '' && !isKnownLabel(candidate)) return candidate;
  }
  // A heading the model forgot to bold (or one that reads like a label): take
  // what stands before the first separator, and only when it plausibly is a
  // word or phrase. Labelled lines are sections, never headings.
  for (const line of lines.slice(0, 2)) {
    if (labelOf(line) !== null) continue;
    let end = line.length;
    for (const separator of HEADING_SEPARATORS) {
      const at = line.indexOf(separator);
      if (at !== -1) end = Math.min(end, at);
    }
    const candidate = unquote(stripEmphasis(line.slice(0, end)))
      .replace(/^[-*•]\s*/, '')
      .trim();
    if (plausibleWord(candidate)) return candidate;
  }
  return '';
}

// ---- The labelled sections --------------------------------------------------

interface Section {
  label: string;
  /** The text that followed the label on its own line, then the body. */
  lines: string[];
}

const normalizeLabel = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The label names the format uses; a plain (non-bold) label must be one of these to count. */
const KNOWN_LABELS = [
  'meaning',
  'vietnamese',
  'nghia',
  'definition',
  'example',
  'collocation',
  'synonym',
  'antonym',
  'word family',
  'usage note',
  'usage',
  'common mistakes',
  'pronunciation',
  'ipa',
  'part of speech',
  'note',
];

function isKnownLabel(label: string): boolean {
  const normalized = normalizeLabel(label);
  return KNOWN_LABELS.some((known) =>
    [known, `${known}s`].some(
      (form) => normalized === form || normalized.startsWith(`${form} `) || normalized.endsWith(` ${form}`),
    ),
  );
}

/**
 * A label starts a section: a bold name with a colon ("**Definition:** …"),
 * a known plain name with one ("Meaning (Vietnamese): …"), or a known bold
 * name on its own line. Ordinary prose is never a label.
 */
function labelOf(line: string): { label: string; rest: string } | null {
  const framed = /^[-*•]?\s*\*{1,2}\s*([^*]{1,60}?)\s*:\s*\*{0,2}\s*(.*)$/.exec(line);
  if (framed !== null) return { label: framed[1]!.trim(), rest: framed[2]!.trim() };
  const dashed = /^[-*•]?\s*\*{1,2}\s*([^*]{1,60}?)\s*\*{0,2}\s*[—–-]\s+(.*)$/.exec(line);
  if (dashed !== null && isKnownLabel(dashed[1]!)) return { label: dashed[1]!.trim(), rest: dashed[2]!.trim() };
  const bare = /^[-*•]?\s*\*{1,2}\s*([^*]{1,60}?)\s*\*{0,2}\s*$/.exec(line);
  if (bare !== null && isKnownLabel(bare[1]!)) return { label: bare[1]!.trim(), rest: '' };
  const plain = /^[-*•]?\s*([A-Za-z][A-Za-z ()/&-]{0,50}?)\s*:\s*(.*)$/.exec(line);
  if (plain !== null && isKnownLabel(plain[1]!)) return { label: plain[1]!.trim(), rest: plain[2]!.trim() };
  return null;
}

function collectSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const label = labelOf(line);
    if (label !== null) {
      current = { label: label.label, lines: label.rest === '' ? [] : [label.rest] };
      sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

function findSection(sections: Section[], ...words: string[]): Section | undefined {
  return sections.find((section) => {
    const normalized = normalizeLabel(section.label);
    return words.every((word) => normalized.includes(word));
  });
}

/** A section's text: bullet items on their own lines, wrapped prose joined. */
function textOf(section: Section | undefined): string {
  if (section === undefined) return '';
  const items: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      items.push(plainText(paragraph.join(' ')));
      paragraph = [];
    }
  };
  for (const line of section.lines) {
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flush();
      const item = plainText(bullet[1]!);
      if (item !== '') items.push(item);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return items.filter((item) => item !== '').join('\n');
}

// ---- The example ------------------------------------------------------------

/**
 * The English half of one example. A split is only trusted where the part
 * being dropped is recognisably Vietnamese; anything else is left empty.
 */
function englishSentence(block: string): string {
  const text = tidy(block);
  if (text === '') return '';
  if (!VIETNAMESE.test(text)) return plainText(text);

  // The translation may sit on its own line, under the sentence.
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length > 1) {
    const firstVietnamese = lines.findIndex((line) => VIETNAMESE.test(line));
    if (firstVietnamese > 0) {
      const english = tidy(lines.slice(0, firstVietnamese).join(' '));
      if (!VIETNAMESE.test(english)) return plainText(english);
    }
  }

  // Or after a dash, arrow or bracket on the same line.
  const separated = splitAtSeparator(text);
  if (separated !== null) return plainText(separated);

  // Or directly after the sentence's full stop.
  const sentence = firstEnglishSentence(text);
  return sentence === null ? '' : plainText(sentence);
}

function splitAtSeparator(text: string): string | null {
  for (const separator of [' — ', ' – ', ' → ', ' - ', ' | ', ' : ']) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(separator, from);
      if (at === -1) break;
      const before = text.slice(0, at).trim();
      const after = text.slice(at + separator.length).trim();
      if (before !== '' && after !== '') {
        if (VIETNAMESE.test(after) && !VIETNAMESE.test(before)) return before;
        if (VIETNAMESE.test(before) && !VIETNAMESE.test(after)) return after;
      }
      from = at + separator.length;
    }
  }
  // A trailing translation in brackets: "… (nghĩa là …)".
  const paren = /^(.*?[.!?"”’])\s*\(([^()]*)\)\s*$/.exec(text);
  if (paren !== null && VIETNAMESE.test(paren[2]!)) return paren[1]!;
  return null;
}

function firstEnglishSentence(text: string): string | null {
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index + 1;
    const before = text.slice(0, end).trim();
    const after = text.slice(end).trim();
    if (!VIETNAMESE.test(before) && VIETNAMESE.test(after)) return before;
  }
  return null;
}

/** The first example, as a whole sentence: later examples are never joined in. */
function firstExample(section: Section | undefined): string {
  if (section === undefined) return '';
  const blocks: string[] = [];
  if (section.lines.some((line) => BULLET.test(line))) {
    let current: string[] | null = null;
    for (const line of section.lines) {
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        if (current !== null) blocks.push(current.join('\n'));
        current = [bullet[1]!.trim()];
      } else if (current !== null) {
        current.push(line.trim());
      }
    }
    if (current !== null) blocks.push(current.join('\n'));
  } else {
    for (const line of section.lines) if (line.trim() !== '') blocks.push(line.trim());
  }
  const first = blocks[0];
  return first === undefined ? '' : englishSentence(first);
}

// ---- The register-labelled examples -----------------------------------------

const REGISTER_LABELS: Record<string, { register: ExampleRegister; label: string }> = {
  simple: { register: 'simple', label: 'Simple' },
  'more academic': { register: 'more_academic', label: 'More academic' },
  'super academic': { register: 'super_academic', label: 'Super academic' },
};

/** Groups the Example section's lines into one block per bullet/paragraph, like firstExample does. */
function exampleBlocks(section: Section | undefined): string[] {
  if (section === undefined) return [];
  const blocks: string[] = [];
  if (section.lines.some((line) => BULLET.test(line))) {
    let current: string[] | null = null;
    for (const line of section.lines) {
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        if (current !== null) blocks.push(current.join('\\n'));
        current = [bullet[1]!.trim()];
      } else if (current !== null) {
        current.push(line.trim());
      }
    }
    if (current !== null) blocks.push(current.join('\\n'));
  } else {
    for (const line of section.lines) if (line.trim() !== '') blocks.push(line.trim());
  }
  return blocks;
}

/** Strips list markers and emphasis so a block can be matched against a register label. */
function stripListAndEmphasis(text: string): string {
  return text
    .replace(/^[-*•]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^\*{1,2}\s*/, '')
    .replace(/\*{1,2}\s*$/, '')
    .trim();
}

function parseExamples(section: Section | undefined): ExtractedExample[] {
  const blocks = exampleBlocks(section);
  const parsed: ExtractedExample[] = [];
  for (const block of blocks) {
    const cleaned = stripListAndEmphasis(block);
    const match = /^([A-Za-z ]+?)\s*[:：]\s*(.*)$/s.exec(cleaned);
    if (match === null) continue;
    const key = match[1]!.trim().toLowerCase();
    const info = REGISTER_LABELS[key];
    if (info === undefined) continue;
    const sentence = englishSentence(match[2]!.trim());
    if (sentence === '') continue;
    parsed.push({ register: info.register, label: info.label, sentence });
  }
  // Fall back: an old reply with unlabelled examples counts as a single simple one.
  if (parsed.length === 0) {
    const first = firstExample(section);
    if (first !== '') parsed.push({ register: 'simple', label: 'Simple', sentence: first });
  }
  return parsed;
}

// ---- The whole reply --------------------------------------------------------

export function extractVocabularyAnalysis(content: string): ExtractedAnalysis {
  const lines = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const word = extractWord(lines);
  const sections = collectSections(lines);
  const meaning =
    textOf(findSection(sections, 'meaning', 'vietnamese')) ||
    textOf(findSection(sections, 'vietnamese')) ||
    textOf(findSection(sections, 'nghia'));
  const definition = textOf(findSection(sections, 'definition'));
  const exampleSection = findSection(sections, 'example');
  const examples = parseExamples(exampleSection);
  const example = examples.find((item) => item.register === 'simple')?.sentence || firstExample(exampleSection);

  const missing: ExtractedField[] = [];
  if (word === '') missing.push('word');
  if (meaning === '') missing.push('meaning');
  if (definition === '') missing.push('definition');
  if (example === '') missing.push('example');

  return { word, meaning, definition, example, examples, missing };
}
