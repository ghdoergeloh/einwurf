import { ConvexError } from "convex/values";
import { MARK_CELL_PATTERN } from "./cells";

export const SLUG_PATTERN = /^[A-Za-z0-9]{22}$/;
export const OSM_ID_PATTERN = /^(way|relation)\/\d{1,15}$/;
export const MAX_NAME_LENGTH = 80;
export const MAX_PLACE_LENGTH = 200;
export const MAX_MARKS_PER_CAMPAIGN = 20000;
/** Höchstens so viele neue Aktionen pro Minute, über alle Nutzer. */
export const MAX_CAMPAIGNS_PER_MINUTE = 20;

export function assertSlug(slug: string) {
  if (!SLUG_PATTERN.test(slug)) throw new ConvexError("Ungültiger Link");
}

export function assertOsmId(osmId: string) {
  if (!OSM_ID_PATTERN.test(osmId)) throw new ConvexError("Ungültiges Haus");
}

export function assertCell(cell: string) {
  if (!MARK_CELL_PATTERN.test(cell)) throw new ConvexError("Ungültiger Kartenausschnitt");
}

export function assertLatLng(lat: number, lng: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ConvexError("Ungültige Koordinaten");
  }
}

export function cleanText(value: string, max: number, field: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new ConvexError(`${field} fehlt`);
  if (trimmed.length > max) throw new ConvexError(`${field} ist zu lang`);
  return trimmed;
}
