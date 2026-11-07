/**
 * Loot chests in Supabase. The rolls happen in the server; this store only
 * loads the state and commits a whole opening, which the database does in one
 * transaction (`apply_gacha_open`, migration version 22) so a dropped
 * connection can neither half-open a chest nor open one twice.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { RARITIES } from '../../shared/gacha.js';
import type { ApplyOutcome, GachaSnapshot, GachaStore, InventoryRow } from '../gacha-service.js';
import { DatabaseError } from './supabase-database.js';

/**
 * Untyped on purpose: the generated `Database` type is kept for the tables the
 * rest of the app uses, and these three are newer than it. Every row is checked
 * below before the rest of the server trusts it.
 */
type Client = SupabaseClient;

const stateRowSchema = z.object({
  keys: z.number().int(),
  shards: z.number().int(),
  since_epic: z.number().int(),
  since_legendary: z.number().int(),
  opens: z.number().int(),
  last_grant_day: z.string().nullable(),
});

const inventoryRowSchema = z.object({
  item_id: z.string(),
  rarity: z.enum(RARITIES),
  quantity: z.number().int(),
});

const openingResultSchema = z.object({
  itemId: z.string(),
  rarity: z.enum(RARITIES),
  duplicate: z.boolean(),
  shards: z.number().int(),
});

const outcomeSchema = z.object({
  outcome: z.enum(['applied', 'conflict', 'replayed']),
  results: z.array(openingResultSchema).optional(),
});

function failure(message: string): DatabaseError {
  return new DatabaseError('unavailable', message);
}

export function createSupabaseGachaStore(url: string, publicKey: string, accessToken: string): GachaStore {
  const client: Client = createClient(url, publicKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    available: true,

    async load(): Promise<{ state: GachaSnapshot; inventory: InventoryRow[] }> {
      const [stateResult, inventoryResult] = await Promise.all([
        client
          .from('gacha_state')
          .select('keys, shards, since_epic, since_legendary, opens, last_grant_day')
          .maybeSingle(),
        client.from('gacha_inventory').select('item_id, rarity, quantity'),
      ]);
      if (stateResult.error) throw failure(`Reading the chests failed: ${stateResult.error.message}`);
      if (inventoryResult.error) throw failure(`Reading the collection failed: ${inventoryResult.error.message}`);

      const state = stateResult.data === null ? null : stateRowSchema.safeParse(stateResult.data);
      if (state !== null && !state.success) throw failure('The chests came back in an unexpected shape.');
      const inventory = z.array(inventoryRowSchema).safeParse(inventoryResult.data ?? []);
      if (!inventory.success) throw failure('The collection came back in an unexpected shape.');

      return {
        state:
          state === null || state.data === null
            ? { keys: 0, shards: 0, pity: { sinceEpic: 0, sinceLegendary: 0 }, opens: 0, lastGrantDay: null }
            : {
                keys: state.data.keys,
                shards: state.data.shards,
                pity: { sinceEpic: state.data.since_epic, sinceLegendary: state.data.since_legendary },
                opens: state.data.opens,
                lastGrantDay: state.data.last_grant_day,
              },
        inventory: inventory.data.map((row) => ({ itemId: row.item_id, rarity: row.rarity, quantity: row.quantity })),
      };
    },

    async find(requestId: string) {
      const { data, error } = await client
        .from('gacha_opens')
        .select('results')
        .eq('request_id', requestId)
        .maybeSingle();
      if (error) throw failure(`Reading a previous opening failed: ${error.message}`);
      if (data === null) return null;
      const results = z.array(openingResultSchema).safeParse(data.results);
      if (!results.success) throw failure('A previous opening came back in an unexpected shape.');
      return results.data;
    },

    async apply({ expectedOpens, state, inventory, open }): Promise<ApplyOutcome> {
      const { data, error } = await client.rpc('apply_gacha_open', {
        p_expected_opens: expectedOpens,
        p_keys: state.keys,
        p_shards: state.shards,
        p_since_epic: state.pity.sinceEpic,
        p_since_legendary: state.pity.sinceLegendary,
        p_opens: state.opens,
        p_last_grant_day: state.lastGrantDay,
        p_items: inventory.map((row) => ({ item_id: row.itemId, rarity: row.rarity, quantity: row.quantity })),
        p_request_id: open?.requestId ?? null,
        p_chest_id: open?.chestId ?? null,
        p_count: open?.count ?? 0,
        p_results: open?.results ?? [],
      });
      if (error) throw failure(`Saving the opening failed: ${error.message}`);
      const parsed = outcomeSchema.safeParse(data);
      if (!parsed.success) throw failure('The database answered an opening in an unexpected shape.');
      if (parsed.data.outcome === 'replayed') {
        return { outcome: 'replayed', results: parsed.data.results ?? [] };
      }
      return parsed.data.outcome === 'applied' ? { outcome: 'applied' } : { outcome: 'conflict' };
    },
  };
}
