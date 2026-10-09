import { describe, expect, it } from 'vitest';
import { decideAxis, swipeDirection } from '../../src/lib/gesture.js';

describe('decideAxis', () => {
  it('stays undecided for small movements', () => {
    expect(decideAxis(0, 0, 12)).toBe('undecided');
    expect(decideAxis(8, -6, 12)).toBe('undecided');
    expect(decideAxis(-11, 11, 12)).toBe('undecided');
  });

  it('locks to horizontal when the movement is mostly sideways', () => {
    expect(decideAxis(20, 5, 12)).toBe('horizontal');
    expect(decideAxis(-30, 12, 12)).toBe('horizontal');
  });

  it('locks to vertical for scrolling, including on a tie', () => {
    expect(decideAxis(5, 20, 12)).toBe('vertical');
    expect(decideAxis(4, -40, 12)).toBe('vertical');
    expect(decideAxis(15, 15, 12)).toBe('vertical');
  });
});

describe('swipeDirection', () => {
  it('tells left from right', () => {
    expect(swipeDirection(120, 88)).toBe('right');
    expect(swipeDirection(-120, 88)).toBe('left');
  });

  it('ignores movements short of the threshold', () => {
    expect(swipeDirection(87, 88)).toBeNull();
    expect(swipeDirection(-87, 88)).toBeNull();
    expect(swipeDirection(0, 88)).toBeNull();
  });

  it('counts a movement exactly at the threshold', () => {
    expect(swipeDirection(88, 88)).toBe('right');
    expect(swipeDirection(-88, 88)).toBe('left');
  });

  it('respects a configured threshold', () => {
    expect(swipeDirection(60, 50)).toBe('right');
    expect(swipeDirection(60, 150)).toBeNull();
  });
});
