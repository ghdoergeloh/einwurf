import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

interface Props {
  url: string;
  title: string;
  isNew: boolean;
  onClose: () => void;
}

export function ShareSheet({ url, title, isNew, onClose }: Props) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const shareText = `Hilf mit beim Flyer-Verteilen („${title}“). Tippe auf der Karte auf jedes Haus, das einen Flyer bekommen hat:`;

  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: "#15171c", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [url]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Zwischenablage gesperrt: Link bleibt markierbar sichtbar. */
    }
  }

  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-center" role="presentation">
      <button
        type="button"
        aria-label="Schließen"
        onClick={onClose}
        className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        tabIndex={-1}
        className="relative max-h-[92dvh] w-full touch-pan-y overscroll-contain select-text max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl outline-none sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-black/10 sm:hidden" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="share-title" className="text-xl font-semibold tracking-tight">
              {isNew ? "Deine Aktion ist bereit 🎉" : "Helfer einladen"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              Wer diesen Link hat, sieht die Karte und kann Häuser markieren. Teile ihn nur mit deinem Team.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-black/5"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-5 grid place-items-center rounded-2xl bg-paper p-4">
          {qr ? (
            <img src={qr} alt="QR-Code mit dem Link zur Verteilaktion" className="size-52 rounded-xl bg-white p-2" />
          ) : (
            <div className="size-52 animate-pulse rounded-xl bg-black/5" />
          )}
          <p className="mt-2 text-xs text-muted">Zum Scannen mit der Handykamera</p>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-black/10 p-1.5 pl-3.5">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Link zur Verteilaktion"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-3 outline-none"
          />
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-xl bg-ink px-3.5 py-2 text-sm font-medium text-white transition hover:bg-ink-2"
          >
            {copied ? "Kopiert ✓" : "Kopieren"}
          </button>
        </div>

        <div className={`mt-3 grid gap-2 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-4 py-3 text-sm font-semibold text-white transition hover:brightness-95"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3Z" />
            </svg>
            WhatsApp
          </a>
          {canShare && (
          <button
            type="button"
            onClick={() => navigator.share?.({ title, text: shareText, url }).catch(() => {})}
            className="flex items-center justify-center gap-2 rounded-2xl bg-sun px-4 py-3 text-sm font-semibold text-ink transition hover:bg-sun-deep"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Teilen …
          </button>
          )}
        </div>
        {isNew && (
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-2xl px-4 py-3 text-sm font-medium text-ink-3 hover:bg-black/5"
          >
            Zur Karte
          </button>
        )}
      </div>
    </div>
  );
}
