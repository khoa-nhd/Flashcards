/**
 * Reminders (schema version 20): each account keeps its own devices and
 * choices; the timer's functions answer only its secret, claim each reminder
 * once, give no learning data, and forget gone devices. Then one whole run,
 * against a stand-in push service.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  candidateRowSchema,
  claimRowSchema,
  leagueRowSchema,
  runReminders,
  socialRowSchema,
  type NotifyDatabase,
  type PushSender,
} from '../../server/notification-service.js';
import { createTestDatabase, readMigrations, type TestDatabase } from '../helpers/test-database.js';

const SECRET = 's'.repeat(40);

let db: TestDatabase;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  await db.admin('delete from public.notify_secret');
  await db.admin('insert into public.notify_secret (hash) values ($1)', [createHash('sha256').update(SECRET).digest('hex')]);
  alice = await db.createUser('alice@example.com');
  bob = await db.createUser('bob@example.com');
});

const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

const device = (user: string, name: string) =>
  db.as(user, (s) => s.query(`select public.push_take_device($1, 'key-${name}', 'auth-${name}')`, [`https://push.example/${name}`]));

/** The reminder functions as the timer calls them: the anonymous role. */
function notifyDatabase(token = SECRET): NotifyDatabase {
  const rows = async (sql: string, params: unknown[]) =>
    db
      .asAnon((s) => s.query<{ row: unknown }>(`select to_jsonb(t) as row from ${sql} t`, params))
      .then((result) => result.map((each) => each.row));
  return {
    candidates: async (now) =>
      (await rows('public.notify_candidates($1, $2::timestamptz)', [token, now.toISOString()])).map((row) => candidateRowSchema.parse(row)),
    league: async (week) => (await rows('public.notify_league($1, $2::date)', [token, week])).map((row) => leagueRowSchema.parse(row)),
    social: async (week) => (await rows('public.notify_social($1, $2::date)', [token, week])).map((row) => socialRowSchema.parse(row)),
    claim: async (sends, state) =>
      (await rows('public.notify_claim($1, $2::jsonb, $3::jsonb)', [token, JSON.stringify(sends), JSON.stringify(state)])).map((row) =>
        claimRowSchema.parse(row),
      ),
    gone: async (endpoints) => {
      await db.asAnon((s) => s.query('select public.notify_gone($1, $2::text[])', [token, endpoints]));
    },
  };
}

describe('devices and choices', () => {
  it('belong to their own account only', async () => {
    await device(alice, 'a');
    expect(await db.as(bob, (s) => s.query('select * from public.push_subscriptions'))).toEqual([]);
    expect(
      await code(
        db.as(bob, (s) =>
          s.query(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://x', 'k', 'a')`, [alice]),
        ),
      ),
    ).toBe('42501');
    await db.as(bob, (s) => s.query(`delete from public.push_subscriptions`));
    expect(await db.admin('select count(*)::int as n from public.push_subscriptions')).toEqual([{ n: 1 }]);
  });

  it('move a browser to whoever subscribed on it last', async () => {
    await device(alice, 'shared');
    await device(bob, 'shared');
    expect(await db.admin('select user_id = $1 as bob from public.push_subscriptions', [bob])).toEqual([{ bob: true }]);
  });
});

describe('the timer’s functions', () => {
  it('answer only the timer’s secret', async () => {
    expect(await code(notifyDatabase('wrong').candidates(new Date()))).toBe('42501');
    expect(await code(notifyDatabase('wrong').claim([], []))).toBe('42501');
    await db.admin('delete from public.notify_secret');
    expect(await code(notifyDatabase().candidates(new Date()))).toBe('55000');
  });

  it('list accounts with a device, with no learning data in them', async () => {
    await device(alice, 'a');
    const rows = await notifyDatabase().candidates(new Date());
    expect(rows.map((row) => row.user_id)).toEqual([alice]);
    expect(rows[0]).toMatchObject({ streak: true, reminder_at: '19:00:00', met_today: false, due: 0, sent: [] });
    expect(Object.keys(rows[0]!)).not.toContain('word');
  });

  it('claim a reminder once, giving its devices, however often it is claimed', async () => {
    await device(alice, 'a');
    await device(alice, 'b');
    const send = [{ user: alice, day: '2026-10-29', key: 'streak_2000' }];
    expect(await notifyDatabase().claim(send, [{ user: alice, key: 'zone', value: 'x' }])).toHaveLength(2);
    expect(await notifyDatabase().claim(send, [])).toEqual([]);
    const [row] = await notifyDatabase().candidates(new Date());
    expect(row!.state).toEqual({ zone: 'x' });
  });

  it('forget devices the push service says are gone', async () => {
    await device(alice, 'a');
    await notifyDatabase().gone(['https://push.example/a']);
    expect(await db.admin('select * from public.push_subscriptions')).toEqual([]);
  });

  it('cannot be read or written as tables', async () => {
    for (const table of ['notify_secret', 'notifications_sent', 'notify_state']) {
      expect(await code(db.as(alice, (s) => s.query(`select * from public.${table}`)))).toBe('42501');
    }
  });
});

describe('a timer run', () => {
  it('sends what is due once, and forgets a device that is gone', async () => {
    await device(alice, 'a');
    await device(alice, 'gone');
    const sent: string[] = [];
    const sender: PushSender = {
      async send(target, payload) {
        if (target.endpoint.endsWith('/gone')) return 'gone';
        sent.push(`${target.endpoint} ${JSON.parse(payload).title}`);
        return 'ok';
      },
    };
    // Alice studied yesterday, so her streak is alive; it is 20:05 in her zone (UTC).
    await db.admin(
      `insert into public.study_days (user_id, day, new_goal, review_goal, practice_goal, met) values ($1, current_date - 1, 0, 0, 0, true)`,
      [alice],
    );
    const at = new Date();
    at.setUTCHours(20, 5, 0, 0);
    const first = await runReminders(notifyDatabase(), sender, at);
    expect(first).toMatchObject({ people: 1, sent: 1, gone: 1 });
    expect(sent).toEqual(['https://push.example/a Giữ chuỗi ngày nhé']);
    // A second run in the same quarter hour sends nothing again.
    expect(await runReminders(notifyDatabase(), sender, at)).toMatchObject({ sent: 0 });
    expect(await db.admin('select endpoint from public.push_subscriptions')).toEqual([{ endpoint: 'https://push.example/a' }]);
  });
});

describe('upgrading to version 20', () => {
  it('runs on a database at version 19, and can be run again', async () => {
    const migrations = readMigrations();
    const at = migrations.findIndex((migration) => migration.name.endsWith('_notifications.sql'));
    const old = await createTestDatabase({ migrations: at });
    try {
      await old.db.exec(migrations[at]!.sql);
      await old.db.exec(migrations[at]!.sql);
      expect(await old.admin('select public.app_schema_version() as v')).toEqual([{ v: 20 }]);
    } finally {
      await old.close();
    }
  }, 120_000);
});
