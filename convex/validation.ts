import { ConvexError } from "convex/values";

export const SLUG_PATTERN = /^[A-Za-z0-9]{22}$/;
export const OSM_ID_PATTERN = /^(way|relation)\/\d{1,15}$/;
export const MAX_NAME_LENGTH = 80;
export const MAX_PLACE_LENGTH = 200;
export const MAX_POINTS_PER_MARK = 5000;
export const MAX_MARKS_PER_CAMPAIGN = 20000;

export function assertSlug(slug: string) {
  if (!SLUG_PATTERN.test(slug)) throw new ConvexError("Ungültiger Link");
}

export function assertOsmId(osmId: string) {
  if (!OSM_ID_PATTERN.test(osmId)) throw new ConvexError("Ungültiges Haus");
}

export function assertLatLng(lat: number, lng: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ConvexError("Ungültige Koordinaten");
  }
}

export function assertGeometry(geometry: number[][][][]) {
  let points = 0;
  if (geometry.length === 0) throw new ConvexError("Leere Geometrie");
  for (const polygon of geometry) {
    if (polygon.length === 0) throw new ConvexError("Leeres Polygon");
    for (const ring of polygon) {
      if (ring.length < 4) throw new ConvexError("Ring zu kurz");
      for (const p of ring) {
        if (p.length !== 2) throw new ConvexError("Ungültiger Punkt");
        assertLatLng(p[1], p[0]);
        points++;
      }
    }
  }
  if (points > MAX_POINTS_PER_MARK) throw new ConvexError("Geometrie zu groß");
}

export function cleanText(value: string, max: number, field: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new ConvexError(`${field} fehlt`);
  if (trimmed.length > max) throw new ConvexError(`${field} ist zu lang`);
  return trimmed;
}
