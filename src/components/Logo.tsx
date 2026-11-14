export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#15171c" />
      <path d="M14 30 32 15l18 15v19a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3Z" fill="#ffd60a" />
      <path d="M24 36h16v4H24z" fill="#15171c" />
    </svg>
  );
}

export function Logo() {
  return (
    <a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
      <LogoMark />
      <span className="text-lg">Einwurf</span>
    </a>
  );
}
