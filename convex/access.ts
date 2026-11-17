import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { SLUG_PATTERN } from "./validation";

/**
 * Rechte über den Schlüssel im Link:
 *  - Bearbeiten-Schlüssel (`slug`, Link `/v/…`): alles lesen und ändern.
 *  - Ansehen-Schlüssel (`viewKey`, Link `/a/…`): nur lesen.
 *
 * Mutationen nehmen nur den Bearbeiten-Schlüssel an und suchen deshalb mit
 * `campaignForEdit` (Index `by_slug`). Lesende Queries nehmen beide über
 * `campaignForRead`, dürfen dem Aufrufer mit `access: "view"` aber nie den
 * `slug` zurückgeben.
 */
export type Access = "edit" | "view";

export async function campaignForEdit(ctx: QueryCtx, slug: string): Promise<Doc<"campaigns"> | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  return await ctx.db
    .query("campaigns")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

export async function campaignForRead(
  ctx: QueryCtx,
  key: string,
): Promise<{ campaign: Doc<"campaigns">; access: Access } | null> {
  if (!SLUG_PATTERN.test(key)) return null;
  const edit = await campaignForEdit(ctx, key);
  if (edit) return { campaign: edit, access: "edit" };
  const view = await ctx.db
    .query("campaigns")
    .withIndex("by_viewKey", (q) => q.eq("viewKey", key))
    .unique();
  return view ? { campaign: view, access: "view" } : null;
}

/** Ist der Schlüssel schon vergeben, als Bearbeiten- oder Ansehen-Schlüssel irgendeiner Aktion? */
export async function keyTaken(ctx: QueryCtx, key: string): Promise<boolean> {
  return (await campaignForRead(ctx, key)) !== null;
}
