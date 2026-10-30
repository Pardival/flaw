/** Écran de chargement : le logo au centre, le temps que les textes locaux s'ouvrent. */
export function Splash({ label, leaving = false }: { label: string; leaving?: boolean }) {
  return (
    <div className="splash" data-leaving={leaving ? "true" : "false"} role="status">
      <svg className="splash-mark" viewBox="0 0 16 16" aria-hidden="true">
        <rect width="16" height="16" rx="3.5" className="flaw-logo-tile" />
        <path d="M5 3.5h6.5v2H7v2h3v2H7v3H5z" className="flaw-logo-f splash-f" pathLength={1} />
        <circle cx="11" cy="11.5" r="1.05" className="flaw-logo-dot splash-dot" />
      </svg>
      <span className="splash-word" aria-hidden="true">
        Flaw
      </span>
      <span className="splash-bar" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
