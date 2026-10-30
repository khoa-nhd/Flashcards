/**
 * Reminders by web push (docs/gamification-plan.md, phase 4).
 *
 * Two halves. Each signed-in account keeps its own devices and choices,
 * through its own session like everything else. The timer's run calls the
 * server with CRON_TOKEN; the server holds no key that reads every account,
 * so it asks the database's reminder functions, which answer only that
 * secret, decides with the shared rules, claims each reminder (so none goes
 * twice) and sends it. Devices the push service says are gone are forgotten.
 */
import webPush from 'web-push';
import { z } from 'zod';
import type { NotificationSettings, NotificationsResponse } from '../shared/api.js';
import { leagueWeekOf } from '../shared/gamification/league.js';
import { decide, type Candidate, type LeagueMember, type Reminder, type Social } from '../shared/notifications.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types.js';
import { DatabaseError, toDatabaseError, type VocabularyDatabase } from './supabase/supabase-database.js';

// ---- Sending ----

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSender {
  /** `gone` when the push service says the device no longer exists (404 or 410). */
  send(device: PushDevice, payload: string): Promise<'ok' | 'gone' | 'failed'>;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** A mailto: or https: address the push services can reach the sender at. */
  subject: string;
}

export function createWebPushSender(vapid: VapidKeys): PushSender {
  return {
    async send(device, payload) {
      try {
        await webPush.sendNotification({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, {
          vapidDetails: vapid,
          TTL: 60 * 60,
          timeout: 10_000,
        });
        return 'ok';
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return 'gone';
        // The push service's reply can name the device; only the status reaches the log.
        console.error(`Sending a reminder failed: ${status ?? 'no response'}`);
        return 'failed';
      }
    },
  };
}

/** What a reminder carries to the device: what to show and where a tap goes. */
export const reminderPayload = (reminder: Pick<Reminder, 'title' | 'body' | 'url' | 'key'>) =>
  JSON.stringify({ title: reminder.title, body: reminder.body, url: reminder.url, tag: reminder.key.split(':')[0] });

// ---- The timer's run ----

const time = z.string().regex(/^\d{2}:\d{2}/);

export const candidateRowSchema = z.object({
  user_id: z.string(),
  time_zone: z.string(),
  language: z.string(),
  local_day: z.string(),
  local_time: time,
  streak: z.boolean(),
  league: z.boolean(),
  reminder: z.boolean(),
  social: z.boolean(),
  reminder_at: time,
  quiet_from: time,
  quiet_until: time,
  met_today: z.boolean(),
  streak_alive: z.boolean(),
  due: z.coerce.number().int(),
  sent: z.array(z.string()).nullable(),
  state: z.record(z.string(), z.string()).nullable(),
  league_result: z.record(z.string(), z.unknown()).nullable(),
  golden_hour: z.boolean(),
});

export const leagueRowSchema = z.object({
  group_id: z.string(),
  tier: z.coerce.number().int(),
  created_at: z.string(),
  member_id: z.string(),
  week_xp: z.coerce.number().int(),
  joined_at: z.string(),
});

export const socialRowSchema = z.object({
  kind: z.enum(['friend', 'challenge']),
  user_id: z.string(),
  other_id: z.string(),
  other_nickname: z.string().nullable(),
  my_xp: z.coerce.number().int(),
  other_xp: z.coerce.number().int(),
  ref: z.string().nullable(),
});

export const claimRowSchema = z.object({
  user_id: z.string(),
  day: z.string(),
  key: z.string(),
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

/** The reminder functions, already bound to the timer's secret. */
export interface NotifyDatabase {
  candidates(now: Date): Promise<Array<z.infer<typeof candidateRowSchema>>>;
  league(week: string): Promise<Array<z.infer<typeof leagueRowSchema>>>;
  social(week: string): Promise<Array<z.infer<typeof socialRowSchema>>>;
  claim(
    sends: Array<{ user: string; day: string; key: string }>,
    state: Array<{ user: string; key: string; value: string }>,
  ): Promise<Array<z.infer<typeof claimRowSchema>>>;
  gone(endpoints: string[]): Promise<void>;
}

/** The reminder functions through the API, as the anonymous role: only the secret opens them. */
export function createSupabaseNotifyDatabase(client: SupabaseClient<Database>, token: string): NotifyDatabase {
  const rows = async <T>(
    fn: 'notify_candidates' | 'notify_league' | 'notify_social' | 'notify_claim',
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ) => {
    const { data, error, status } = await client.rpc(fn, { p_token: token, ...args } as never);
    if (error) throw toDatabaseError(error, status);
    const parsed = z.array(schema).safeParse(data ?? []);
    if (!parsed.success) throw new DatabaseError('unavailable', 'The database returned reminders in an unexpected shape.');
    return parsed.data;
  };
  return {
    candidates: (now) => rows('notify_candidates', { p_now: now.toISOString() }, candidateRowSchema),
    league: (week) => rows('notify_league', { p_week: week }, leagueRowSchema),
    social: (week) => rows('notify_social', { p_week: week }, socialRowSchema),
    claim: (sends, state) => rows('notify_claim', { p_sends: sends, p_state: state }, claimRowSchema),
    async gone(endpoints) {
      const { error, status } = await client.rpc('notify_gone', { p_token: token, p_endpoints: endpoints });
      if (error) throw toDatabaseError(error, status);
    },
  };
}

export function candidateFrom(row: z.infer<typeof candidateRowSchema>): Candidate {
  const result = row.league_result;
  return {
    user: row.user_id,
    timeZone: row.time_zone,
    language: row.language === 'en' ? 'en' : 'vi',
    day: row.local_day,
    time: row.local_time.slice(0, 5),
    kinds: { streak: row.streak, league: row.league, reminder: row.reminder, social: row.social },
    reminderAt: row.reminder_at.slice(0, 5),
    quietFrom: row.quiet_from.slice(0, 5),
    quietUntil: row.quiet_until.slice(0, 5),
    metToday: row.met_today,
    streakAlive: row.streak_alive,
    due: row.due,
    sent: row.sent ?? [],
    state: row.state ?? {},
    leagueResult:
      result === null || typeof result.id !== 'string'
        ? null
        : { id: result.id, tier: Number(result.tier ?? 1), rank: Number(result.rank ?? 0), outcome: String(result.outcome ?? 'stay') },
    goldenHourOn: row.golden_hour,
  };
}

export interface RunSummary {
  people: number;
  sent: number;
  gone: number;
  failed: number;
}

/** One run of the timer: decide, claim, send, forget gone devices. */
export async function runReminders(db: NotifyDatabase, sender: PushSender, now: Date): Promise<RunSummary> {
  const week = leagueWeekOf(now);
  const [candidates, league, social] = await Promise.all([db.candidates(now), db.league(week), db.social(week)]);
  const members: LeagueMember[] = league.map((row) => ({
    group: row.group_id,
    tier: row.tier,
    createdAt: row.created_at,
    user: row.member_id,
    xp: row.week_xp,
    joinedAt: row.joined_at,
  }));
  const links: Social[] = social.map((row) =>
    row.kind === 'friend'
      ? { kind: 'friend', user: row.user_id, other: row.other_id, nickname: row.other_nickname, myXp: row.my_xp, otherXp: row.other_xp }
      : { kind: 'challenge', user: row.user_id, other: row.other_id, nickname: row.other_nickname, id: row.ref ?? row.other_id },
  );
  const decision = decide(candidates.map(candidateFrom), members, links, now);
  const reminders = new Map(decision.sends.map((send) => [`${send.user}|${send.day}|${send.key}`, send]));
  // Claimed first: a reminder another run already claimed comes back with no device, and is not sent again.
  const claimed = await db.claim(
    decision.sends.map(({ user, day, key }) => ({ user, day, key })),
    decision.state,
  );
  let sent = 0;
  let failed = 0;
  const gone: string[] = [];
  for (const row of claimed) {
    const reminder = reminders.get(`${row.user_id}|${row.day}|${row.key}`);
    if (reminder === undefined) continue;
    const outcome = await sender.send({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, reminderPayload(reminder));
    if (outcome === 'ok') sent += 1;
    else if (outcome === 'gone') gone.push(row.endpoint);
    else failed += 1;
  }
  if (gone.length > 0) await db.gone(gone);
  return { people: candidates.length, sent, gone: gone.length, failed };
}

// ---- Each account's own ----

/** Where an account keeps its reminder choices and devices. */
export type NotificationStore = Pick<
  VocabularyDatabase,
  'notificationSettings' | 'saveNotificationSettings' | 'pushDevices' | 'addPushDevice' | 'removePushDevice'
>;

/** The sample data's: kept in memory, for one nobody. */
export function createMemoryNotificationStore(): NotificationStore {
  let settings: NotificationSettings | null = null;
  const devices = new Map<string, PushDevice>();
  return {
    notificationSettings: async () => settings,
    saveNotificationSettings: async (next) => {
      settings = next;
    },
    pushDevices: async () => [...devices.values()],
    addPushDevice: async (device) => {
      devices.set(device.endpoint, device);
    },
    removePushDevice: async (endpoint) => {
      devices.delete(endpoint);
    },
  };
}

export interface NotificationServiceOptions {
  database: NotificationStore;
  /** Null where the server has no VAPID keys: nothing can be sent. */
  sender: PushSender | null;
  publicKey: string | null;
  /** The database keeps reminders (schema version 20). */
  available: boolean;
}

const DEFAULTS: NotificationSettings = {
  streak: true,
  league: true,
  reminder: true,
  social: true,
  reminderAt: '19:00',
  quietFrom: '23:00',
  quietUntil: '07:00',
};

export class NotificationService {
  constructor(private readonly options: NotificationServiceOptions) {}

  private unavailable(): string | null {
    if (!this.options.available) return 'Reminders need the latest database update (version 20).';
    if (this.options.sender === null || this.options.publicKey === null) return 'Reminders are not set up on the server yet (VAPID keys).';
    return null;
  }

  private need<T>(method: T | undefined): T {
    if (method === undefined || this.unavailable() !== null) {
      throw new DatabaseError('schema_missing', this.unavailable() ?? 'Reminders need the latest database update (version 20).');
    }
    return method;
  }

  async view(): Promise<NotificationsResponse> {
    const reason = this.unavailable();
    if (reason !== null) return { available: false, reason, publicKey: null, settings: DEFAULTS, devices: [] };
    const { database } = this.options;
    const [settings, devices] = await Promise.all([
      this.need(database.notificationSettings).call(database),
      this.need(database.pushDevices).call(database),
    ]);
    return {
      available: true,
      reason: null,
      publicKey: this.options.publicKey,
      settings: settings ?? DEFAULTS,
      devices: devices.map((device) => device.endpoint),
    };
  }

  async save(settings: Partial<NotificationSettings>): Promise<NotificationsResponse> {
    const { database } = this.options;
    const current = (await this.need(database.notificationSettings).call(database)) ?? DEFAULTS;
    await this.need(database.saveNotificationSettings).call(database, { ...current, ...settings });
    return this.view();
  }

  async subscribe(device: PushDevice): Promise<NotificationsResponse> {
    const { database } = this.options;
    await this.need(database.addPushDevice).call(database, device);
    return this.view();
  }

  async unsubscribe(endpoint: string): Promise<NotificationsResponse> {
    const { database } = this.options;
    await this.need(database.removePushDevice).call(database, endpoint);
    return this.view();
  }

  /** Sends a test reminder to the account's own devices. */
  async test(language: 'vi' | 'en'): Promise<{ sent: number; gone: number }> {
    const { database } = this.options;
    const devices = await this.need(database.pushDevices).call(database);
    const payload = reminderPayload({
      key: 'test',
      url: '/',
      title: language === 'en' ? 'Reminders are on' : 'Đã bật nhắc nhở',
      body: language === 'en' ? 'This is how a reminder will look.' : 'Nhắc nhở sẽ hiện như thế này.',
    });
    let sent = 0;
    let gone = 0;
    for (const device of devices) {
      const outcome = await this.options.sender!.send(device, payload);
      if (outcome === 'ok') sent += 1;
      if (outcome === 'gone') {
        gone += 1;
        await this.need(database.removePushDevice).call(database, device.endpoint);
      }
    }
    return { sent, gone };
  }
}
