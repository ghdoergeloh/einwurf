import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/**
 * Zähler einer Aktion (Flyer, nicht möglich, Notizen) in einer eigenen Zeile statt am
 * Datensatz der Aktion. Fast jede Query liest die Aktion (Schlüssel prüfen); stünden die
 * Zähler dort, würde jeder Tipp bei allen offenen Geräten alle Queries neu ausführen,
 * auch die großen wie areas.list mit allen Grenzen. Das kostete das meiste Database I/O.
 *
 * Ältere Aktionen haben die Zähler noch am Datensatz (markCount, blockedCount, noteCount);
 * sie gelten, bis die erste Änderung die eigene Zeile anlegt.
 */
export type Counts = { done: number; blocked: number; notes: number };

const rowOf = (ctx: QueryCtx, campaign: Doc<"campaigns">) =>
  ctx.db.query("campaignCounts").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).unique();

const legacy = (campaign: Doc<"campaigns">): Counts => ({
  done: campaign.markCount ?? 0,
  blocked: campaign.blockedCount ?? 0,
  notes: campaign.noteCount ?? 0,
});

export async function countsOf(ctx: QueryCtx, campaign: Doc<"campaigns">): Promise<Counts> {
  const row = await rowOf(ctx, campaign);
  return row ? { done: row.done, blocked: row.blocked, notes: row.notes } : legacy(campaign);
}

/** Zähler um `delta` ändern (nie unter 0). */
export async function addCounts(ctx: MutationCtx, campaign: Doc<"campaigns">, delta: Partial<Counts>) {
  const row = await rowOf(ctx, campaign);
  const now = row ?? legacy(campaign);
  const next = {
    done: Math.max(0, now.done + (delta.done ?? 0)),
    blocked: Math.max(0, now.blocked + (delta.blocked ?? 0)),
    notes: Math.max(0, now.notes + (delta.notes ?? 0)),
  };
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert("campaignCounts", { campaignId: campaign._id, ...next });
}
