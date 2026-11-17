import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { SLUG_PATTERN } from "./validation";

/**
 * Rollen über den geheimen Schlüssel im Link, jede umfasst die nächste:
 *  - admin: Admin-Schlüssel (`adminKey`, siehe #2): Gebietsauswahl und alles andere.
 *  - edit:  Bearbeiten-Schlüssel (`slug`, Link `/v/…`): Häuser markieren, Teilen, Vorladen.
 *  - view:  Ansehen-Schlüssel (`viewKey`, Link `/a/…`): nur lesen.
 *
 * Jede öffentliche Funktion mit Schlüssel nutzt `campaignByKey` (lesen) oder `requireRole`
 * (ändern). Ein Ergebnis darf nur Schlüssel enthalten, deren Rolle der Aufrufer schon hat:
 * Mit dem Ansehen-Schlüssel weder slug noch adminKey, mit dem Bearbeiten-Schlüssel nie adminKey.
 * Der slug ist intern außerdem der Schlüssel für Kontingent und Vorladen (nie an Leser geben).
 */
export type Role = "admin" | "edit" | "view";

const RANK: Record<Role, number> = { view: 0, edit: 1, admin: 2 };

/** Hat `role` mindestens die Rechte von `min`? */
export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export async function campaignByKey(
  ctx: QueryCtx,
  key: string,
): Promise<{ campaign: Doc<"campaigns">; role: Role } | null> {
  if (!SLUG_PATTERN.test(key)) return null;
  const edit = await ctx.db.query("campaigns").withIndex("by_slug", (q) => q.eq("slug", key)).unique();
  if (edit) return { campaign: edit, role: "edit" };
  const admin = await ctx.db.query("campaigns").withIndex("by_adminKey", (q) => q.eq("adminKey", key)).unique();
  if (admin) return { campaign: admin, role: "admin" };
  const view = await ctx.db.query("campaigns").withIndex("by_viewKey", (q) => q.eq("viewKey", key)).unique();
  return view ? { campaign: view, role: "view" } : null;
}

/** Aktion zum Schlüssel, wenn er mindestens die Rolle `min` hat; sonst ConvexError. */
export async function requireRole(ctx: QueryCtx, key: string, min: Role) {
  const found = await campaignByKey(ctx, key);
  if (!found) throw new ConvexError("Verteilaktion nicht gefunden");
  if (!hasRole(found.role, min)) {
    throw new ConvexError(min === "admin" ? "Das geht nur mit dem Admin-Link" : "Mit diesem Link lässt sich nichts ändern");
  }
  return found;
}

/** Ist der Schlüssel schon vergeben, in irgendeiner Rolle irgendeiner Aktion? */
export async function keyTaken(ctx: QueryCtx, key: string): Promise<boolean> {
  return (await campaignByKey(ctx, key)) !== null;
}
