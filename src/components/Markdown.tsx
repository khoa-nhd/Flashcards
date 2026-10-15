/**
 * Safe Markdown renderer with a small, audited subset.
 * Does not execute HTML or scripts.
 */
import { useMemo } from 'react';
import { Fragment } from 'react';

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}

/** Parse inline markdown: **bold**, *italic*, `code`, [link](url). */
function parseInline(text: string): string {
  // Code spans first (protect content from other parsing)
  let result = text.replace(/`([^`\n]+)`/g, '<code class="bg-line px-1.5 rounded text-sm font-mono">$1</code>');

  // Bold
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  result = result.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Links
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-accent underline hover:no-underline">$1</a>');

  return result;
}

/** Parse markdown blocks. */
function parseBlocks(markdown: string): React.ReactNode[] {
  const lines = markdown.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }
    const trimmed = line.trim();

    // Code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine || nextLine.trim().startsWith('```')) break;
        codeLines.push(nextLine);
        i++;
      }
      const code = codeLines.join('\n');
      blocks.push(
        <pre key={blocks.length} className="bg-line/50 rounded-xl p-4 overflow-x-auto my-2">
          <code className={`language-${lang || 'text'} text-sm font-mono`}>{escapeHtml(code)}</code>
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      blocks.push(
        <Fragment key={blocks.length}>
          <h1 className={`font-semibold my-3 ${level === 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'}`}>
            {parseInline(text)}
          </h1>
        </Fragment>
      );
      i++;
      continue;
    }

    // Unordered list
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const items: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine || (!nextLine.trim().startsWith('- ') && !nextLine.trim().startsWith('* '))) break;
        items.push(nextLine.trim().slice(2));
        i++;
      }
      blocks.push(
        <ul key={blocks.length} className="list-disc list-inside space-y-1 my-2 ml-4">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm">{parseInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch && orderedMatch[1] && orderedMatch[2]) {
      const items: string[] = [];
      let expectedNum = parseInt(orderedMatch[1], 10);
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine) break;
        const match = nextLine.trim().match(/^(\d+)\.\s+(.+)$/);
        if (!match || !match[1] || !match[2] || parseInt(match[1], 10) !== expectedNum) break;
        items.push(match[2]);
        expectedNum++;
        i++;
      }
      blocks.push(
        <ol key={blocks.length} className="list-decimal list-inside space-y-1 my-2 ml-4">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm">{parseInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine || !nextLine.trim().startsWith('> ')) break;
        quoteLines.push(nextLine.trim().slice(2));
        i++;
      }
      blocks.push(
        <blockquote key={blocks.length} className="border-l-2 border-accent pl-4 my-2 italic text-muted">
          {quoteLines.map((q, idx) => (
            <p key={idx} className="text-sm">{parseInline(q)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // Horizontal rule
    if (trimmed === '---' || trimmed === '***') {
      blocks.push(<hr key={blocks.length} className="my-4 border-line" />);
      i++;
      continue;
    }

    // Paragraph
    if (trimmed) {
      const paragraphLines: string[] = [trimmed];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine) break;
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed) break;
        if (nextTrimmed.startsWith('```') || nextTrimmed.match(/^#{1,3}\s/) || nextTrimmed.startsWith('- ') || nextTrimmed.startsWith('* ') || nextTrimmed.match(/^\d+\.\s/) || nextTrimmed.startsWith('> ') || nextTrimmed === '---' || nextTrimmed === '***') break;
        paragraphLines.push(nextTrimmed);
        i++;
      }
      blocks.push(
        <p key={blocks.length} className="my-2 text-sm leading-relaxed">
          {parseInline(paragraphLines.join(' '))}
        </p>
      );
      continue;
    }

    // Empty line
    i++;
  }

  return blocks;
}

export function Markdown({ content, className = '' }: { content: string; className?: string }) {
  const nodes = useMemo(() => parseBlocks(content), [content]);

  return <div className={`prose prose-sm max-w-none ${className}`}>{nodes}</div>;
}