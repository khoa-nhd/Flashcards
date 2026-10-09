// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { shortcutFor, type ShortcutIntent } from '../../src/hooks/useReviewShortcuts.js';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Dispatches a real keydown on `target` and reports how it is interpreted at the window. */
function intentFor(target: Element, init: KeyboardEventInit): ShortcutIntent | null {
  let intent: ShortcutIntent | null = null;
  const capture = (event: KeyboardEvent) => {
    intent = shortcutFor(event);
  };
  window.addEventListener('keydown', capture);
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  window.removeEventListener('keydown', capture);
  return intent;
}

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

const SPACE = { key: ' ', code: 'Space' };
const LEFT = { key: 'ArrowLeft', code: 'ArrowLeft' };
const RIGHT = { key: 'ArrowRight', code: 'ArrowRight' };

describe('shortcutFor', () => {
  it('maps the three review keys when nothing in particular is focused', () => {
    expect(intentFor(document.body, SPACE)).toBe('flip');
    expect(intentFor(document.body, LEFT)).toBe('not_remember');
    expect(intentFor(document.body, RIGHT)).toBe('remember');
  });

  it('ignores every other key', () => {
    for (const key of ['Enter', 'a', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape']) {
      expect(intentFor(document.body, { key })).toBeNull();
    }
  });

  it.each([
    ['a text input', '<input type="text" />'],
    ['a password input', '<input type="password" />'],
    ['a textarea', '<textarea></textarea>'],
    ['a select', '<select><option>one</option></select>'],
    ['an editable element', '<div contenteditable="true"></div>'],
    ['a custom textbox', '<div role="textbox" tabindex="0"></div>'],
    ['a slider', '<div role="slider" tabindex="0"></div>'],
  ])('leaves all keys alone while the user is in %s', (_name, html) => {
    const element = mount(html);
    expect(intentFor(element, SPACE)).toBeNull();
    expect(intentFor(element, LEFT)).toBeNull();
    expect(intentFor(element, RIGHT)).toBeNull();
  });

  it('leaves keys alone inside an editable region, not just on it', () => {
    const child = mount('<div contenteditable="true"><p><b>text</b></p></div>').querySelector('b')!;
    expect(intentFor(child, SPACE)).toBeNull();
    expect(intentFor(child, RIGHT)).toBeNull();
  });

  it('lets Space activate a focused button or link instead of flipping', () => {
    expect(intentFor(mount('<button>Refresh</button>'), SPACE)).toBeNull();
    expect(intentFor(mount('<a href="/x">link</a>'), SPACE)).toBeNull();
    expect(intentFor(mount('<details><summary>more</summary></details>').querySelector('summary')!, SPACE)).toBeNull();
  });

  it('still answers with the arrow keys while a button has focus', () => {
    const button = mount('<button>Refresh</button>');
    expect(intentFor(button, LEFT)).toBe('not_remember');
    expect(intentFor(button, RIGHT)).toBe('remember');
  });

  it('ignores keys combined with a modifier', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(intentFor(document.body, { ...RIGHT, [modifier]: true })).toBeNull();
      expect(intentFor(document.body, { ...SPACE, [modifier]: true })).toBeNull();
    }
  });

  it('ignores a key another handler already consumed', () => {
    const consume = (event: Event) => event.preventDefault();
    document.body.addEventListener('keydown', consume);
    expect(intentFor(document.body, SPACE)).toBeNull();
    document.body.removeEventListener('keydown', consume);
  });
});
