/**
 * Umschalter „Bearbeiten / Ansehen“ für Helfer mit dem Bearbeiten-Link: Im Ansehen-Modus
 * verhält sich die Karte wie beim Ansehen-Link (nichts antippbar). Gemerkt je Gerät und
 * Aktion; ohne Speicher (privater Modus, gesperrt) gilt immer „Bearbeiten“.
 */
export type ViewMode = "edit" | "view";

const key = (slug: string) => `einwurf:modus:${slug}`;

export function loadViewMode(slug: string): ViewMode {
  try {
    return localStorage.getItem(key(slug)) === "view" ? "view" : "edit";
  } catch {
    return "edit";
  }
}

export function saveViewMode(slug: string, mode: ViewMode) {
  try {
    if (mode === "view") localStorage.setItem(key(slug), "view");
    else localStorage.removeItem(key(slug));
  } catch {
    /* Nicht gemerkt; gilt bis zum Neuladen. */
  }
}
