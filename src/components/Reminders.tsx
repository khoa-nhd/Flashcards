/**
 * Reminders by web push (docs/gamification-plan.md, phase 4): the Settings
 * section, and the one-time offer on the Dashboard after the day's goals are
 * met for the first time (not on the first visit).
 */
import { useEffect, useState } from 'react';
import type { NotificationSettings, NotificationsResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { currentEndpoint, permission, pushSupport, subscribe, unsubscribe } from '../lib/push.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, LABEL, SECTION_TITLE } from './ui.js';

const ASKED_KEY = 'flashcards:reminders-offered';

function wasOffered(): boolean {
  try {
    return window.localStorage.getItem(ASKED_KEY) !== null;
  } catch {
    return false;
  }
}

function markOffered(): void {
  try {
    window.localStorage.setItem(ASKED_KEY, new Date().toISOString());
  } catch {
    // Without storage the offer may come again; nothing else depends on it.
  }
}

/** Subscribes this browser and tells the server. Returns the server's view, or null when the person said no. */
async function turnOn(api: ReturnType<typeof useApp>['api'], publicKey: string): Promise<NotificationsResponse | null> {
  const subscription = await subscribe(publicKey);
  if (subscription === null) return null;
  return api.subscribePush(subscription);
}

function IosHint({ language }: { language: UiLanguage }) {
  return (
    <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn-ink">
      {pick(
        language,
        'On iPhone and iPad, reminders work only from the app on the home screen: tap Share, then “Add to Home Screen”, open the app from there and turn reminders on (iOS 16.4 or later).',
        'Trên iPhone và iPad, nhắc nhở chỉ chạy khi mở app từ Màn hình chính: bấm Chia sẻ, chọn “Thêm vào MH chính”, mở app từ đó rồi bật nhắc nhở (iOS 16.4 trở lên).',
      )}
    </p>
  );
}

const KINDS: Array<{
  key: keyof Pick<NotificationSettings, 'streak' | 'league' | 'reminder' | 'social'>;
  en: [string, string];
  vi: [string, string];
}> = [
  {
    key: 'streak',
    en: ['Streak about to end', 'At 20:00 and 22:30 if today’s goals are not met.'],
    vi: ['Streak sắp đứt', 'Lúc 20:00 và 22:30 nếu hôm nay chưa đạt mục tiêu.'],
  },
  {
    key: 'reminder',
    en: ['Daily reminder', 'At the time below, with the words waiting.'],
    vi: ['Nhắc học mỗi ngày', 'Vào giờ dưới đây, kèm số từ đang chờ.'],
  },
  {
    key: 'league',
    en: ['League', 'Pushed out of the promotion zone, Sunday evening near the bottom, the week’s result.'],
    vi: ['Giải đấu', 'Bị đẩy khỏi vùng lên hạng, tối Chủ nhật sắp xuống hạng, kết quả tuần.'],
  },
  {
    key: 'social',
    en: ['Friends and events', 'A friend passing you, a challenge, the golden hour about to start.'],
    vi: ['Bạn bè và sự kiện', 'Bạn bè vượt bạn, lời thách đấu, giờ vàng sắp bắt đầu.'],
  },
];

export function ReminderSettings() {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const reminders = useRemote(api.fetchNotifications, 'Could not load your reminders.');
  const [busy, setBusy] = useState<string | null>(null);
  /** This browser's push address, read again after every change. */
  const [here, setHere] = useState<string | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    let current = true;
    currentEndpoint().then(
      (endpoint) => {
        if (current) setHere(endpoint);
      },
      () => {
        if (current) setHere(null);
      },
    );
    return () => {
      current = false;
    };
  }, [changes]);

  if (reminders.status !== 'ready') return null;
  const data = reminders.data;
  const support = pushSupport();
  const onHere = here != null && data.devices.includes(here);

  const act = async (key: string, work: () => Promise<NotificationsResponse | null>, done?: string) => {
    setBusy(key);
    try {
      const next = await work();
      if (next !== null) reminders.adopt(next);
      if (done !== undefined) toasts.show({ message: done });
    } catch (cause) {
      toasts.show({
        message:
          cause instanceof ApiError || cause instanceof Error
            ? cause.message
            : pick(language, 'That did not work.', 'Không thực hiện được.'),
      });
    } finally {
      setBusy(null);
      setChanges((count) => count + 1);
    }
  };
  const save = (settings: Partial<NotificationSettings>) => act('save', () => api.saveNotifications(settings));

  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Reminders', 'Nhắc nhở')}</h2>
      {!data.available ? (
        <p className={HELP}>{data.reason}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {onHere ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-medium text-good-ink">
                  <Icon name="check" className="size-4" />
                  {pick(language, 'On for this device', 'Đã bật trên thiết bị này')}
                </span>
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  disabled={busy !== null}
                  onClick={() =>
                    void act('test', async () => {
                      const result = await api.testPush();
                      toasts.show({
                        message: pick(
                          language,
                          `Sent to ${result.sent} ${result.sent === 1 ? 'device' : 'devices'}.`,
                          `Đã gửi tới ${result.sent} thiết bị.`,
                        ),
                      });
                      return api.fetchNotifications();
                    })
                  }
                >
                  {busy === 'test' && <Spinner />}
                  {pick(language, 'Send a test', 'Gửi thử')}
                </button>
                <button
                  type="button"
                  className={BUTTON_GHOST}
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      'off',
                      async () => {
                        const endpoint = await unsubscribe();
                        return endpoint === null ? null : api.unsubscribePush(endpoint);
                      },
                      pick(language, 'Reminders are off for this device.', 'Đã tắt nhắc nhở trên thiết bị này.'),
                    )
                  }
                >
                  {pick(language, 'Turn off here', 'Tắt trên thiết bị này')}
                </button>
              </>
            ) : support === 'supported' ? (
              <button
                type="button"
                className={BUTTON_PRIMARY}
                disabled={busy !== null || permission() === 'denied'}
                onClick={() => void act('on', () => turnOn(api, data.publicKey!), pick(language, 'Reminders are on.', 'Đã bật nhắc nhở.'))}
              >
                {busy === 'on' && <Spinner />}
                {pick(language, 'Turn on reminders here', 'Bật nhắc nhở trên thiết bị này')}
              </button>
            ) : null}
            {data.devices.length > 0 && (
              <span className={HELP}>
                {pick(
                  language,
                  `${data.devices.length} ${data.devices.length === 1 ? 'device' : 'devices'} in all`,
                  `Tổng ${data.devices.length} thiết bị`,
                )}
              </span>
            )}
          </div>
          {support === 'ios-needs-home-screen' && <IosHint language={language} />}
          {support === 'unsupported' && (
            <p className={HELP}>{pick(language, 'This browser cannot show reminders.', 'Trình duyệt này không hiện được nhắc nhở.')}</p>
          )}
          {permission() === 'denied' && (
            <p className={HELP}>
              {pick(
                language,
                'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.',
                'Trang này đang bị chặn thông báo. Hãy cho phép trong cài đặt trang của trình duyệt rồi quay lại.',
              )}
            </p>
          )}

          <fieldset className="flex flex-col gap-3" disabled={busy !== null}>
            {KINDS.map((kind) => {
              const [name, detail] = language === 'en' ? kind.en : kind.vi;
              return (
                <label key={kind.key} className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--color-accent)]"
                    checked={data.settings[kind.key]}
                    onChange={(event) => void save({ [kind.key]: event.target.checked })}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-ink">{name}</span>
                    <span className={HELP}>{detail}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ['reminderAt', pick(language, 'Daily reminder at', 'Giờ nhắc học')],
                ['quietFrom', pick(language, 'Quiet from', 'Yên lặng từ')],
                ['quietUntil', pick(language, 'Quiet until', 'Yên lặng tới')],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-1.5">
                <span className={LABEL}>{label}</span>
                <input
                  type="time"
                  className={INPUT}
                  defaultValue={data.settings[key]}
                  disabled={busy !== null}
                  onBlur={(event) => {
                    if (event.target.value !== '' && event.target.value !== data.settings[key])
                      void save({ [key]: event.target.value.slice(0, 5) });
                  }}
                />
              </label>
            ))}
          </div>
          <p className={HELP}>
            {pick(
              language,
              'At most six a day, never in the quiet hours. Times are in your account’s time zone.',
              'Tối đa sáu thông báo mỗi ngày, không gửi trong giờ yên lặng. Giờ theo múi giờ tài khoản.',
            )}
          </p>
        </>
      )}
    </section>
  );
}

/** The one-time offer, once the day's goals have been met. */
export function ReminderPrompt({ metToday }: { metToday: boolean }) {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const [hidden, setHidden] = useState(wasOffered);
  const [busy, setBusy] = useState(false);
  const reminders = useRemote(api.fetchNotifications, 'Could not load your reminders.');
  const support = pushSupport();
  if (
    hidden ||
    !metToday ||
    reminders.status !== 'ready' ||
    !reminders.data.available ||
    permission() !== 'default' ||
    support === 'unsupported'
  )
    return null;
  const close = () => {
    markOffered();
    setHidden(true);
  };
  const accept = async () => {
    setBusy(true);
    try {
      const next = await turnOn(api, reminders.data.publicKey!);
      if (next !== null)
        toasts.show({ message: pick(language, 'Reminders are on. Change them in Settings.', 'Đã bật nhắc nhở. Đổi trong Cài đặt.') });
    } catch (cause) {
      toasts.show({
        message: cause instanceof Error ? cause.message : pick(language, 'Could not turn reminders on.', 'Không bật được nhắc nhở.'),
      });
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <section className={`${CARD} pool pool-top flex flex-col gap-3 p-4`} aria-label={pick(language, 'Reminders', 'Nhắc nhở')}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="clock" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className={SECTION_TITLE}>{pick(language, 'Keep this streak going?', 'Giữ chuỗi ngày này nhé?')}</h2>
          <p className={HELP}>
            {pick(
              language,
              'A reminder in the evening if the day’s goals are not met yet. Never in the night, at most six a day.',
              'Một lời nhắc buổi tối nếu chưa đạt mục tiêu ngày. Không bao giờ gửi ban đêm, tối đa sáu lần mỗi ngày.',
            )}
          </p>
        </div>
      </div>
      {support === 'ios-needs-home-screen' ? (
        <>
          <IosHint language={language} />
          <button type="button" className={`${BUTTON_GHOST} self-end`} onClick={close}>
            {pick(language, 'Got it', 'Đã hiểu')}
          </button>
        </>
      ) : (
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={close}>
            {pick(language, 'Not now', 'Để sau')}
          </button>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void accept()}>
            {busy && <Spinner />}
            {pick(language, 'Turn on reminders', 'Bật nhắc nhở')}
          </button>
        </div>
      )}
    </section>
  );
}
