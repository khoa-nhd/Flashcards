// @vitest-environment jsdom
/**
 * The indicator's own mechanics on fake clocks: lines swap when their dwell
 * time passes, the layout hands over when a reply starts streaming, and
 * reduced motion holds one line for the whole wait.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThinkingIndicator } from '../../src/components/ThinkingIndicator.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const line = () => screen.getByTestId('thinking-line').textContent ?? '';

describe('ThinkingIndicator', () => {
  it('swaps the line once a dwell time passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    render(<ThinkingIndicator messageId="message-rotation" streaming={false} />);
    const first = line();
    expect(first.length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });

    const second = line();
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it('hands over to the streaming row when the reply starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const view = render(<ThinkingIndicator messageId="message-handover" streaming={false} />);
    expect(screen.getByTestId('thinking-indicator')).toHaveAttribute('data-phase', 'waiting');

    view.rerender(<ThinkingIndicator messageId="message-handover" streaming={true} />);

    expect(screen.getByTestId('thinking-indicator')).toHaveAttribute('data-phase', 'streaming');
    expect(line().length).toBeGreaterThan(0);
  });

  it('holds one line for the whole wait under reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    render(<ThinkingIndicator messageId="message-calm" streaming={false} />);
    const held = line();
    expect(held.length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(line()).toBe(held);
  });
});
