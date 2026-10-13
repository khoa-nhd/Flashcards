/**
 * "What to do today": the two or three concrete things worth doing now, each
 * with the way to do them. It is worked out from figures the app already has —
 * how many cards are waiting and how many weak words are flagged high — and
 * it never orders or limits anything: the links simply open the right page.
 */
import { ROUTES, buildHref } from '../lib/router.js';
import { Link } from './Link.js';
import { CARD, SECTION_TITLE } from './ui.js';

export interface TodayPlanProps {
  /** How many cards are waiting in the review queue. */
  due: number;
  /** High-priority weak words, or null while that count is not known. */
  weakHigh: number | null;
}

export function TodayPlan({ due, weakHigh }: TodayPlanProps) {
  const steps: Array<{ text: string; to: string; label: string }> = [];
  if (due > 0) {
    steps.push({
      text: `Review the ${due} ${due === 1 ? 'card' : 'cards'} that ${due === 1 ? 'is' : 'are'} due.`,
      to: ROUTES.review,
      label: 'Start review',
    });
  }
  if (weakHigh !== null && weakHigh > 0) {
    steps.push({
      text: `Practise the ${weakHigh} weakest ${weakHigh === 1 ? 'word' : 'words'}.`,
      to: buildHref(ROUTES.practice, { source: 'weak' }),
      label: 'Practise now',
    });
  }
  if (due === 0) {
    steps.push({
      text: 'Nothing is due — add new words or read something to collect more.',
      to: ROUTES.add,
      label: 'Add vocabulary',
    });
  }

  return (
    <section className={`${CARD} p-5`}>
      <h2 className={SECTION_TITLE}>What to do today</h2>
      <ul className="mt-3 flex list-none flex-col gap-2 p-0 text-sm">
        {steps.map((step) => (
          <li key={step.text} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span>{step.text}</span>
            <Link to={step.to} className="shrink-0 font-medium text-accent hover:underline">
              {step.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
