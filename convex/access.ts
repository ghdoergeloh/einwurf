import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { SLUG_PATTERN } from "./validation";

/**
 * Rechte über den Schlüssel im Link:
 *  - Admin-Schlüssel (`adminKey`, Link `/admin/…`): alles, dazu die Gebietsauswahl.
 *  - Bearbeiten-Schlüssel (`slug`, Link `/v/…`): alles lesen, Häuser markieren.
 *
 * Mutationen der Helfer nehmen den Bearbeiten-Schlüssel (`campaignForEdit`); die Admin-Seite
 * erfährt ihn über campaigns.get und nutzt ihn dafür. Nur Admin-Mutationen nehmen den
 * Admin-Schlüssel (`campaignForAdmin`). Lesende Queries nehmen beide über `campaignForRead`.
 * Den Admin-Schlüssel gibt keine Query heraus.
 */
export type Access = "admin" | "edit";

export async function campaignForEdit(ctx: QueryCtx, slug: string): Promise<Doc<"campaigns"> | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  return await ctx.db
    .query("campaigns")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

export async function campaignForAdmin(ctx: QueryCtx, adminKey: string): Promise<Doc<"campaigns"> | null> {
  if (!SLUG_PATTERN.test(adminKey)) return null;
  return await ctx.db
    .query("campaigns")
    .withIndex("by_adminKey", (q) => q.eq("adminKey", adminKey))
    .unique();
}

export async function campaignForRead(
  ctx: QueryCtx,
  key: string,
): Promise<{ campaign: Doc<"campaigns">; access: Access } | null> {
  if (!SLUG_PATTERN.test(key)) return null;
  const edit = await campaignForEdit(ctx, key);
  if (edit) return { campaign: edit, access: "edit" };
  const admin = await campaignForAdmin(ctx, key);
  return admin ? { campaign: admin, access: "admin" } : null;
}

/** Ist der Schlüssel schon vergeben, gleich in welcher Rolle? */
export async function keyTaken(ctx: QueryCtx, key: string): Promise<boolean> {
  return (await campaignForRead(ctx, key)) !== null;
}
