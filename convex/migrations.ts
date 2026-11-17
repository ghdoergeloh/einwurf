import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { keyTaken } from "./access";
import { assertSlug } from "./validation";

/**
 * Einmalige Migration: Ältere Aktionen bekommen einen Admin-Schlüssel.
 * Im Convex-Dashboard unter *Functions → migrations:addAdminKeys* ohne Argumente starten.
 * Danach steht der Schlüssel in der Tabelle `campaigns`, Feld `adminKey`; der Admin-Link ist
 * `https://<eure-seite>/admin/<adminKey>`. Mehrfaches Starten schadet nicht.
 *
 * Eine Action, weil echter Zufall nur dort sicher ist (in Mutationen ist er reproduzierbar).
 */
export const addAdminKeys = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    let total = 0;
    for (;;) {
      const ids = await ctx.runQuery(internal.migrations.withoutAdminKey, {});
      if (ids.length === 0) return total;
      const keys = ids.map(() => randomKey());
      const n = await ctx.runMutation(internal.migrations.setAdminKeys, {
        entries: ids.map((campaignId, i) => ({ campaignId, adminKey: keys[i] })),
      });
      if (n === 0) return total;
      total += n;
    }
  },
});

const BATCH = 100;

export const withoutAdminKey = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("campaigns").withIndex("by_adminKey", (q) => q.eq("adminKey", undefined)).take(BATCH)).map((c) => c._id),
});

export const setAdminKeys = internalMutation({
  args: { entries: v.array(v.object({ campaignId: v.id("campaigns"), adminKey: v.string() })) },
  handler: async (ctx, { entries }) => {
    let n = 0;
    for (const { campaignId, adminKey } of entries) {
      assertSlug(adminKey);
      const c = await ctx.db.get(campaignId);
      if (!c || c.adminKey || (await keyTaken(ctx, adminKey))) continue;
      await ctx.db.patch(campaignId, { adminKey });
      n++;
    }
    return n;
  },
});

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Wie src/lib/slug.ts: 22 Zeichen, etwa 131 Bit Zufall. */
export function randomKey(length = 22): string {
  const out: string[] = [];
  const buf = new Uint8Array(64);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248) out.push(ALPHABET[b % 62]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}
