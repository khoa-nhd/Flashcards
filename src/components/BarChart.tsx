import { useEffect, useId, useRef, useState } from 'react';

export interface BarDatum {
  key: string;
  /** Short text under the bar; may be empty to thin out a crowded axis. */
  tick: string;
  /** Full description of the category, used in the tooltip and the table. */
  label: string;
  value: number;
  /**
   * What to say for this bar instead of the value and its unit. For a category
   * with nothing to plot, give a value of 0 and say why here, so an absent bar
   * is never read as a measured zero.
   */
  text?: string;
}

export interface BarChartProps {
  /** What is plotted; also names the chart for assistive technology. */
  title: string;
  /** Unit after a value in the tooltip, as [singular, plural]. */
  unit: [string, string];
  data: BarDatum[];
  /** Column heading for the categories in the table view. */
  categoryLabel: string;
  height?: number;
}

const numberFormat = new Intl.NumberFormat();

/** Room under the plot for the category labels, in pixels. Matches the `h-6` label row. */
const AXIS_HEIGHT = 24;

/** About how wide one character of an axis label is drawn, and the least space left between two labels. */
const TICK_CHARACTER_WIDTH = 6.5;
const TICK_GAP = 10;

/**
 * Which axis labels to draw. A column can be far narrower than its label (a
 * month of days on a phone), so labels are drawn across their neighbours and
 * thinned until none touches the next. The newest (last) label is always
 * kept, since that is the end of the chart people read first. Until the width
 * is known every label is kept.
 */
export function ticksThatFit(ticks: readonly string[], plotWidth: number | null): boolean[] {
  if (plotWidth === null) return ticks.map((tick) => tick !== '');
  const column = plotWidth / ticks.length;
  const shown = ticks.map(() => false);
  let nextLabelStarts = Number.POSITIVE_INFINITY;
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const tick = ticks[index] ?? '';
    if (tick === '') continue;
    const width = tick.length * TICK_CHARACTER_WIDTH;
    // The first and last labels are kept inside the plot; the others sit centred under their bar.
    const centre = (index + 0.5) * column;
    const left = index === 0 ? 0 : index === ticks.length - 1 ? plotWidth - width : centre - width / 2;
    if (left + width + TICK_GAP > nextLabelStarts) continue;
    shown[index] = true;
    nextLabelStarts = left;
  }
  return shown;
}

/** The smallest "clean" number at or above `value` (1, 2, 5, 10, 20, 50…), never below 1. */
export function niceCeiling(value: number): number {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * A single-series column chart: one hue, thin bars rising from one baseline,
 * recessive grid, a tooltip on hover and keyboard focus, and the same numbers
 * available as a table.
 */
export function BarChart({ title, unit, data, categoryLabel, height = 180 }: BarChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  const plot = useRef<HTMLUListElement>(null);
  const [plotWidth, setPlotWidth] = useState<number | null>(null);

  // The plot's width decides how many axis labels there is room for, and it changes with the window.
  useEffect(() => {
    const element = plot.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) setPlotWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [asTable]);

  const shownTicks = ticksThatFit(
    data.map((datum) => datum.tick),
    plotWidth,
  );

  const max = niceCeiling(Math.max(0, ...data.map((datum) => datum.value)));
  const ticks = max % 2 === 0 ? [max, max / 2, 0] : [max, 0];
  const describe = (datum: BarDatum) =>
    datum.text ?? `${numberFormat.format(datum.value)} ${datum.value === 1 ? unit[0] : unit[1]}`;

  return (
    <figure className="m-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <figcaption id={titleId} className="text-sm font-semibold tracking-tight text-ink">
          {title}
        </figcaption>
        <button
          type="button"
          onClick={() => setAsTable((shown) => !shown)}
          aria-pressed={asTable}
          className="cursor-pointer rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-line-strong/50 hover:text-ink"
        >
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
          <table aria-labelledby={titleId} className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {categoryLabel}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {unit[1][0]?.toUpperCase()}
                  {unit[1].slice(1)}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((datum) => (
                <tr key={datum.key} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    {datum.label}
                  </th>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {datum.text ?? numberFormat.format(datum.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="group" aria-labelledby={titleId} className="flex gap-2">
          {/* Axis values and grid lines share one scale: a tick sits exactly on its line. */}
          <div
            aria-hidden="true"
            className="relative mt-2 w-7 shrink-0 text-xs tabular-nums text-muted"
            style={{ height: height - AXIS_HEIGHT }}
          >
            {ticks.map((tick) => (
              <span
                key={tick}
                className="absolute right-0 -translate-y-1/2 leading-none"
                style={{ top: `${(1 - tick / max) * 100}%` }}
              >
                {numberFormat.format(tick)}
              </span>
            ))}
          </div>

          <div className="relative mt-2 min-w-0 flex-1" style={{ height }}>
            <div aria-hidden="true" className="absolute inset-x-0 top-0" style={{ height: height - AXIS_HEIGHT }}>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute inset-x-0 border-t border-line"
                  style={{ top: `${(1 - tick / max) * 100}%` }}
                />
              ))}
            </div>

            <ul ref={plot} className="absolute inset-0 m-0 flex list-none items-stretch p-0">
              {data.map((datum, index) => (
                <li key={datum.key} className="relative flex min-w-0 flex-1 flex-col">
                  {/* The whole column is the target, so a short bar is as easy to hit as a tall one. */}
                  <button
                    type="button"
                    aria-label={`${datum.label}: ${describe(datum)}`}
                    onPointerEnter={() => setActive(index)}
                    onPointerLeave={() => setActive((current) => (current === index ? null : current))}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive((current) => (current === index ? null : current))}
                    className="flex min-h-0 flex-1 cursor-default items-end justify-center px-px outline-offset-0"
                  >
                    <span
                      className={`block w-full max-w-6 rounded-t-[4px] bg-accent transition-opacity ${
                        active !== null && active !== index ? 'opacity-60' : ''
                      }`}
                      style={{ height: `${(datum.value / max) * 100}%`, minHeight: datum.value > 0 ? 2 : 0 }}
                    />
                  </button>
                  <span aria-hidden="true" className="relative h-6 text-xs leading-none text-muted">
                    {shownTicks[index] && (
                      <span
                        className={`absolute top-1.5 whitespace-nowrap ${
                          index === 0 ? 'left-0' : index === data.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'
                        }`}
                      >
                        {datum.tick}
                      </span>
                    )}
                  </span>
                  {active === index && (
                    <span
                      role="presentation"
                      className={`pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg ${
                        index < data.length / 2 ? 'left-0' : 'right-0'
                      }`}
                    >
                      <strong className="block text-sm font-semibold text-ink">{describe(datum)}</strong>
                      <span className="text-muted">{datum.label}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </figure>
  );
}
