import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Buttons that act on the whole page. */
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {/* The compact top bar already names the page on small screens. */}
        <h1 className="hidden font-serif text-3xl font-semibold tracking-tight md:block">{title}</h1>
        {description !== undefined && <p className="text-sm text-muted md:mt-1">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
