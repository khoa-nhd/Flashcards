/**
 * Version 16 on the database production has: version 15 as it was first
 * applied, before its file gained the practice goal, with days already
 * recorded. tests/fixtures/fsrs_only_as_first_applied.sql is that first form.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MASTERY_ERA_MIGRATIONS, createTestDatabase, readMigrations } from '../helpers/test-database.js';

const OLD_V15 = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'fsrs_only_as_first_applied.sql'), 'utf8');

it('brings a database at the first v15, with days recorded, up to v16', async () => {
  const db = await createTestDatabase({ migrations: MASTERY_ERA_MIGRATIONS });
  await db.db.exec(OLD_V15);
  const user = await db.createUser('owner@example.test');
  await db.admin(
    `insert into public.study_days (user_id, day, new_words, reviews, new_goal, review_goal, met) values ($1, '2026-10-20', 3, 4, 3, 4, true)`,
    [user],
  );
  await db.admin(`insert into public.user_settings (user_id, study_goal_new_words, study_goal_reviews) values ($1, 10, 30)`, [user]);

  const [v15, v16] = readMigrations().slice(MASTERY_ERA_MIGRATIONS);
  // The owner may run the changed v15 file again: it must not stop part way.
  await db.db.exec(v15!.sql);
  await db.db.exec(v16!.sql);
  // And v16 can be run again.
  await db.db.exec(v16!.sql);

  expect(await db.admin('select public.app_schema_version() as v')).toEqual([{ v: 16 }]);
  expect(await db.admin(`select day::text, practice, practice_goal, met from public.study_days`)).toEqual([
    { day: '2026-10-20', practice: 0, practice_goal: 0, met: true },
  ]);
  const counts = await db.as(user, (s) => s.query(`select * from public.study_day_counts('2026-10-24')`));
  expect(counts).toEqual([{ new_words: 0, reviews: 0, practice: 0 }]);
  const met = await db.as(user, (s) =>
    s.query(`select public.record_study_day('2026-10-24', 1, 2, 3, 1, 2, 3, true) as met`),
  );
  expect(met).toEqual([{ met: true }]);
  await db.as(user, (s) => s.query(`update public.user_settings set study_goal_practice = 5`));
  expect(await db.admin(`select study_goal_practice from public.user_settings`)).toEqual([{ study_goal_practice: 5 }]);
  await db.close();
});

it('needs only the v16 file on a database at the first v15', async () => {
  const db = await createTestDatabase({ migrations: MASTERY_ERA_MIGRATIONS });
  await db.db.exec(OLD_V15);
  const user = await db.createUser('owner@example.test');
  await db.admin(
    `insert into public.study_days (user_id, day, new_words, reviews, new_goal, review_goal, met) values ($1, '2026-10-20', 3, 4, 3, 4, true)`,
    [user],
  );
  const v16 = readMigrations()[MASTERY_ERA_MIGRATIONS + 1]!;
  await db.db.exec(v16.sql);
  expect(await db.admin('select public.app_schema_version() as v')).toEqual([{ v: 16 }]);
  expect(await db.as(user, (s) => s.query(`select * from public.study_day_counts('2026-10-24')`))).toEqual([
    { new_words: 0, reviews: 0, practice: 0 },
  ]);
  expect(
    await db.as(user, (s) => s.query(`select public.record_study_day('2026-10-24', 1, 2, 3, 1, 2, 3, false) as met`)),
  ).toEqual([{ met: false }]);
  await db.close();
});
