import { useEffect, useId, useRef, useState } from "react";
import { MAX_NOTE_LENGTH } from "../../convex/validation";

interface Props {
  /** Hausnummer für die Überschrift, falls bekannt. */
  houseNumber: string | null;
  /** Vorhandene Notiz oder null. */
  note: { text: string; updatedAt: number } | null;
  /** `expectedUpdatedAt`: Stand, den der Helfer gerade sieht (null = keine Notiz), siehe convex/notes.ts. */
  onSave: (text: string, expectedUpdatedAt: number | null) => void;
  onDelete: (expectedUpdatedAt: number | null) => void;
  onClose: () => void;
}

/** Notiz zu einem Haus anlegen, ändern oder löschen (langes Drücken oder Rechtsklick auf ein Haus). */
export function NoteSheet({ houseNumber, note, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState(note?.text ?? "");
  const [touched, setTouched] = useState(false);
  /** Stand der Notiz, auf dem der Entwurf beruht. */
  const [base, setBase] = useState(note?.updatedAt ?? null);
  const current = note?.updatedAt ?? null;
  // Kommt die Notiz erst nach dem Öffnen (Zelle lädt noch) oder ändert sie jemand anderes, wird sie
  // übernommen, solange hier noch nichts getippt wurde. Sonst bleibt der Entwurf, mit Warnung.
  useEffect(() => {
    if (touched) return;
    setDraft(note?.text ?? "");
    setBase(note?.updatedAt ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const changedElsewhere = touched && current !== base;
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Der Hintergrund schließt nur, wenn der Druck auf ihm begann; sonst schlösse das Loslassen
  // nach dem langen Drücken den Dialog gleich wieder.
  const backdropPressed = useRef(false);
  const titleId = useId();
  const trimmed = draft.trim();
  const changed = trimmed !== (note?.text ?? "");

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = textRef.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  function save() {
    if (!trimmed) return note ? onDelete(current) : onClose();
    if (changed) onSave(trimmed, current);
    else onClose();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-center" role="presentation">
      <button
        type="button"
        aria-label="Abbrechen"
        tabIndex={-1}
        onPointerDown={() => (backdropPressed.current = true)}
        onClick={() => backdropPressed.current && onClose()}
        className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]"
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="relative max-h-[92dvh] w-full max-w-md touch-pan-y overflow-y-auto overscroll-contain rounded-t-3xl bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl outline-none select-text sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-black/10 sm:hidden" />
        <div className="flex items-center gap-3">
          <span className="size-4 shrink-0 rounded-[4px] bg-note" aria-hidden="true" />
          <h2 id={titleId} className="text-xl font-semibold tracking-tight">
            {note ? "Notiz" : "Notiz anlegen"}
            {houseNumber && <span className="font-normal text-muted"> · Nr. {houseNumber}</span>}
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted">
          {note
            ? `Zuletzt geändert ${ago(note.updatedAt)}. Alle mit dem Link sehen sie.`
            : "Zum Nacharbeiten, z. B. „Briefkasten 3 und 4 haben nichts bekommen“. Alle mit dem Link sehen sie."}
        </p>
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setTouched(true);
          }}
          onKeyDown={(e) => {
            // Strg/⌘ + Enter speichert, Enter allein macht eine neue Zeile.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          maxLength={MAX_NOTE_LENGTH}
          rows={4}
          aria-label="Text der Notiz"
          placeholder="Was ist hier noch zu tun?"
          className="mt-4 block w-full resize-none rounded-2xl border border-black/10 bg-paper px-3.5 py-3 text-base leading-snug outline-none focus:border-note focus:ring-2 focus:ring-note/25"
        />
        {changedElsewhere && (
          <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {note
              ? `Jemand anderes hat die Notiz gerade geändert: „${note.text}“. Speichern ersetzt sie.`
              : "Jemand anderes hat die Notiz gerade gelöscht. Speichern legt sie neu an."}
          </p>
        )}
        <p className="mt-1 text-right text-xs tabular-nums text-muted" aria-live="polite">
          {draft.length} / {MAX_NOTE_LENGTH}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {note && (
            <button
              type="button"
              onClick={() => onDelete(current)}
              className="rounded-2xl px-3 py-3 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Notiz löschen
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-2xl px-4 py-3 text-sm font-medium text-ink-3 hover:bg-black/5">
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={!trimmed && !note}
              className="rounded-2xl bg-note px-5 py-3 text-sm font-semibold text-white transition hover:brightness-95 disabled:opacity-40"
            >
              Speichern
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });

/** „vor 5 Minuten“, „gestern“ … */
function ago(at: number) {
  const s = Math.round((at - Date.now()) / 1000);
  if (s > -60) return "gerade eben";
  const m = Math.round(s / 60);
  if (m > -60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (h > -24) return rtf.format(h, "hour");
  return rtf.format(Math.round(h / 24), "day");
}
