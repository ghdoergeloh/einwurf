/**
 * Stand einer Notiz, den der Dialog beim Speichern mitschickt (convex/notes.ts lehnt ab, wenn
 * jemand anderes sie inzwischen geändert hat). Eine eigene, noch nicht bestätigte Notiz trägt die
 * Uhrzeit des Handys statt der des Servers; für sie wird nicht geprüft (z. B. offline nachgeholt).
 */
export function expectedUpdatedAt(note: { updatedAt: number; pending?: boolean } | null): number | null | undefined {
  if (!note) return null;
  return note.pending ? undefined : note.updatedAt;
}
