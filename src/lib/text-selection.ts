/**
 * Where a selection sits in a body of text: the character offset of its
 * start, and a collapsed range at a known offset. Both walk the rendered
 * text nodes, which is exact as long as the content is rendered whole and
 * unaltered — the way the reading and listening workspaces render it.
 */

/** The character offset of a position inside the rendered text. */
export function offsetWithin(root: HTMLElement, node: Node, within: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current: Node | null = walker.nextNode();
  while (current !== null) {
    if (current === node) return total + within;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return total;
}

/** A collapsed range at a character offset of the content, for scrolling to a place. */
export function rangeAt(root: HTMLElement, offset: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let current: Node | null = walker.nextNode();
  while (current !== null) {
    const length = current.textContent?.length ?? 0;
    if (seen + length >= offset) {
      const range = document.createRange();
      range.setStart(current, Math.max(0, offset - seen));
      range.collapse(true);
      return range;
    }
    seen += length;
    current = walker.nextNode();
  }
  return null;
}
