import { ConvexError } from "convex/values";
import { MARK_CELL_PATTERN } from "./cells";

export const SLUG_PATTERN = /^[A-Za-z0-9]{22}$/;
export const OSM_ID_PATTERN = /^(way|relation)\/\d{1,15}$/;
export const MAX_NAME_LENGTH = 80;
export const MAX_PLACE_LENGTH = 200;
export const MAX_MARKS_PER_CAMPAIGN = 20000;
/** Notizen an Häusern (convex/notes.ts): Länge in Zeichen und Höchstzahl je Aktion. */
export const MAX_NOTE_LENGTH = 500;
export const MAX_NOTES_PER_CAMPAIGN = 5000;
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

/** Mittelpunkt eines Hauses [lng, lat]. */
export function assertCenter(center: number[]) {
  if (center.length !== 2) throw new ConvexError("Ungültige Koordinaten");
  assertLatLng(center[1], center[0]);
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

/**
 * Text einer Notiz: Zeilenumbrüche bleiben (höchstens eine Leerzeile am Stück), Ränder und
 * Steuerzeichen fallen weg. Leer oder zu lang wird abgelehnt.
 */
export function cleanNote(value: string) {
  const text = value
    .replace(/\r\n?/g, "\n")
    // Steuer- und unsichtbare Formatzeichen (z. B. Leerzeichen der Breite null), nur der Zeilenumbruch bleibt.
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? c : ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length === 0) throw new ConvexError("Die Notiz ist leer");
  if (text.length > MAX_NOTE_LENGTH) throw new ConvexError(`Die Notiz ist zu lang (höchstens ${MAX_NOTE_LENGTH} Zeichen)`);
  return text;
}
