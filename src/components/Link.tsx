import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { navigate } from '../lib/router.js';

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
}

/** An ordinary link that navigates in place, while still opening in a new tab when asked to. */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to, { replace });
  };
  return <a href={to} onClick={handleClick} {...rest} />;
}
