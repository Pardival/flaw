import { useTranslate } from "../i18n/i18n.ts";
import { navigate } from "../library/route.ts";

/** Marque Flaw (F à point bleu de l'icône) ; un clic ramène à la liste des textes. */
export function Logo({ className, onHome }: { className?: string; onHome?: () => void }) {
  const t = useTranslate("library");
  return (
    <button
      type="button"
      className={className ? `flaw-logo ${className}` : "flaw-logo"}
      aria-label={t("home")}
      title={t("home")}
      onClick={() => {
        onHome?.();
        navigate({ name: "list" });
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect width="16" height="16" rx="3.5" className="flaw-logo-tile" />
        <path d="M5 3.5h6.5v2H7v2h3v2H7v3H5z" className="flaw-logo-f" />
        <circle cx="11" cy="11.5" r="1.05" className="flaw-logo-dot" />
      </svg>
      <span className="flaw-logo-word">Flaw</span>
    </button>
  );
}
