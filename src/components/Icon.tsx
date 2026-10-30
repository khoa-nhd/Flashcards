const PATHS = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z',
  review: 'M7 4h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-1 16h12M9 9h6M9 12h4',
  add: 'M12 5v14M5 12h14',
  bank: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm0 13a3 3 0 0 1 3-3h11M9 8h6',
  calendar: 'M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM4 10h16M8 3v4M16 3v4',
  insights: 'M4 20h16M7 20v-6M12 20V6M17 20v-9',
  goal: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  weak: 'M5 21V4h11l-2 4 2 4H5',
  practice: 'M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  collections: 'M4 7h6l2 2h8v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Zm0 0V5a1 1 0 0 1 1-1h4l2 2',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 3-.1-1.2 1.6-1.3-1.8-3.1-2 .7a7 7 0 0 0-2-1.2L15.3 3h-3.6l-.4 2a7 7 0 0 0-2 1.1l-2-.7-1.8 3.1 1.6 1.3L7 12l.1 1.2-1.6 1.3 1.8 3.1 2-.7a7 7 0 0 0 2 1.2l.4 1.9h3.6l.4-2a7 7 0 0 0 2-1.1l2 .7 1.8-3.1-1.6-1.3L20 12Z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  warning: 'M12 4 3 20h18L12 4Zm0 6v5m0 3v.01',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  table: 'M4 6h16v12H4V6Zm0 4h16M4 14h16M10 6v12',
  list: 'M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01',
  sync: 'M12 4v1a8 8 0 0 1 0 16M12 4v1a8 8 0 0 0 0 16M4 12h8M20 12h-8',
  alertTriangle: 'M12 4 3 20h18L12 4Zm0 6v5m0 3v.01',
  clock: 'M12 6v6l4 2M12 4v1M12 20v1M4 12h1M20 12h1',
  database: 'M4 6v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Zm0 8v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z',
  league: 'M9 21V11h6v10M3 21v-6h6m6 6v-8h6v8M2 21h20M12 3l1.2 2.4 2.6.4-1.9 1.8.5 2.6L12 9l-2.3 1.2.4-2.6-1.9-1.8 2.6-.4L12 3Z',
  friends: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0m1.5-9a3 3 0 1 0-.5-6m1 9a5 5 0 0 1 4 6',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  share: 'M12 3v12m0-12-4 4m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4Zm0 2H5v1a3 3 0 0 0 3 3m8-4h3v1a3 3 0 0 1-3 3m-4 3v4m-4 3h8m-6 0 .5-3h3l.5 3',
  snow: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-2.2 6a2.3 2.3 0 1 1 3.5 2c-.8.5-1.3 1-1.3 2M12 17h.01',
  speaker: 'M11 5 6 9H2v6h4l5 4V5Zm4.5 5.5a2.5 2.5 0 0 1 0 5',
  'speaker-off': 'M11 5 6 9H2v6h4l5 4V5Zm4.5 5.5m-2.5 0a2.5 2.5 0 0 1 0-5m0 5V5m0 5a2.5 2.5 0 0 1 0 5',
} as const;

export type IconName = keyof typeof PATHS;

/** A small stroked icon. Decorative by default; pair it with visible or accessible text. */
export function Icon({ name, className = 'size-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
