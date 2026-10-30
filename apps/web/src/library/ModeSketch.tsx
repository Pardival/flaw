import type { DocumentMode } from "../local-store/index.ts";

/** Lignes d'un croquis : classe CSS de chaque trait (voir .sketch dans polish.css). */
const SKETCH: Record<Exclude<DocumentMode, "blank">, readonly string[]> = {
  // Titre de chapitre centré, paragraphes à alinéa, folio en pied.
  novel: ["chapter", "gap", "line indent", "line", "line", "line short", "line indent", "line", "line", "line", "line short", "line indent", "line", "folio"],
  // En-tête de scène, action, personnage centré, réplique en retrait, transition à droite.
  screenplay: ["scene", "line", "line short", "character", "dialogue", "dialogue short", "line", "character", "dialogue", "transition"],
  // Titres, paragraphes, liste à puces.
  document: ["h1", "line", "line", "line short", "h2", "bullet", "bullet", "bullet", "line", "line short"],
};

/** Croquis de page propre à chaque mode : on voit d'un coup d'œil ce qu'on va écrire. */
export function ModeSketch({ mode }: { mode: DocumentMode }) {
  return (
    <span className="sketch" data-mode={mode} aria-hidden="true">
      {mode === "blank" ? (
        <span className="sketch-caret" />
      ) : (
        SKETCH[mode].map((kind, index) => <span key={index} className={`sketch-${kind.split(" ").join(" sketch-")}`} />)
      )}
    </span>
  );
}
