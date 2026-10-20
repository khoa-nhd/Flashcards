/**
 * A small Markdown renderer for chat replies. Everything is built as React
 * elements, so text is always escaped and no HTML from the reply is ever
 * interpreted. Links are kept only when they point to http(s) addresses.
 */
import { useMemo, type ReactNode } from 'react';

/** Code spans, bold, italic and links, in that order of precedence. */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const key = nodes.length;
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-line px-1.5 font-mono text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1))}</em>);
    } else {
      const link = LINK.exec(token);
      nodes.push(
        link === null ? (
          token
        ) : (
          <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline hover:no-underline">
            {link[1]}
          </a>
        ),
      );
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+)$/;

/** True for a line that starts a block of its own, so a paragraph stops before it. */
function startsBlock(trimmed: string): boolean {
  return (
    trimmed.startsWith('```') ||
    HEADING.test(trimmed) ||
    BULLET.test(trimmed) ||
    NUMBERED.test(trimmed) ||
    trimmed.startsWith('> ') ||
    trimmed === '---' ||
    trimmed === '***'
  );
}

function blocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    const key = out.length;

    if (trimmed === '') {
      i += 1;
      continue;
    }

    // Fenced code: everything up to the closing fence, blank lines included.
    if (trimmed.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(
        <pre key={key} className="my-2 overflow-x-auto rounded-xl bg-paper p-3">
          <code className="font-mono text-[0.85em]">{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading !== null) {
      // Headings inside a reply are styled, not page headings: the page already has its own.
      out.push(
        <p key={key} className={`mb-1 mt-3 font-semibold ${heading[1]!.length <= 2 ? 'text-base' : 'text-sm'}`}>
          {inline(heading[2]!)}
        </p>,
      );
      i += 1;
      continue;
    }

    if (BULLET.test(trimmed) || NUMBERED.test(trimmed)) {
      const ordered = NUMBERED.test(trimmed);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const match = pattern.exec((lines[i] ?? '').trim());
        if (match === null) break;
        items.push(match[1] ?? '');
        i += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key} className={`my-2 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (trimmed.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('> ')) {
        quote.push((lines[i] ?? '').trim().slice(2));
        i += 1;
      }
      out.push(
        <blockquote key={key} className="my-2 border-l-2 border-accent pl-3 text-muted">
          {inline(quote.join(' '))}
        </blockquote>,
      );
      continue;
    }

    if (trimmed === '---' || trimmed === '***') {
      out.push(<hr key={key} className="my-3 border-line" />);
      i += 1;
      continue;
    }

    const paragraph: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] ?? '').trim();
      if (next === '' || startsBlock(next)) break;
      paragraph.push(next);
      i += 1;
    }
    out.push(
      <p key={key} className="my-2 leading-relaxed">
        {inline(paragraph.join(' '))}
      </p>,
    );
  }

  return out;
}

export function Markdown({ content, className = '' }: { content: string; className?: string }) {
  const nodes = useMemo(() => blocks(content), [content]);
  return <div className={`min-w-0 wrap-anywhere [&>:first-child]:mt-0 [&>:last-child]:mb-0 ${className}`}>{nodes}</div>;
}
