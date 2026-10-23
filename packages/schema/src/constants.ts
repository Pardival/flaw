/**
 * Version provisoire du schéma éditeur (entier).
 * Elle n'est pas figée : un changement de nœuds ou de marques l'incrémente.
 */
export const SCHEMA_VERSION = 1;

/** `screenplay` est le script de film (A-018). */
export const DOCUMENT_MODES = ["novel", "screenplay", "document", "blank"] as const;

export type DocumentMode = (typeof DOCUMENT_MODES)[number];

export const ALIGNS = ["left", "center", "right", "justify"] as const;

export type Align = (typeof ALIGNS)[number];

/** Taille locale sur une sélection, en points. La taille globale du corps est hors du document. */
export const FONT_SIZE_PT_MIN = 8;
export const FONT_SIZE_PT_MAX = 72;

/** Nœuds communs à tous les modes (A-018). */
export const COMMON_NODES = ["title", "hard_break"] as const;

/**
 * Nœuds propres à chaque mode.
 * Le document reste valide s'il contient des nœuds d'un autre mode :
 * le changement de mode ne les retire pas.
 */
export const MODE_NODES = {
  novel: ["chapter_title", "paragraph", "scene_break"],
  screenplay: [
    "scene_heading",
    "action",
    "character",
    "parenthetical",
    "dialogue",
    "transition",
    "centered",
  ],
  document: [
    "heading",
    "paragraph",
    "bullet_list",
    "ordered_list",
    "list_item",
    "bullet_list_2",
    "ordered_list_2",
    "list_item_2",
  ],
  blank: ["paragraph"],
} as const satisfies Record<DocumentMode, readonly string[]>;

/** Blocs de texte. `heading` porte en plus le niveau 1 à 3. */
export const TEXT_BLOCKS = [
  "paragraph",
  "title",
  "chapter_title",
  "heading",
  "scene_heading",
  "action",
  "character",
  "parenthetical",
  "dialogue",
  "transition",
  "centered",
] as const;

export type TextBlockName = (typeof TEXT_BLOCKS)[number];

/** Nouveau script : Courier Prime 12 pt, US Letter (AC-016). */
export const SCREENPLAY_DEFAULTS = {
  fontFamily: "Courier Prime",
  baseFontSizePt: 12,
  pageFormat: "us_letter",
} as const;

/** Mode document : A4 par défaut (AC-018). */
export const DOCUMENT_PAGE_FORMAT = "a4" as const;

export function isDocumentMode(value: unknown): value is DocumentMode {
  return typeof value === "string" && (DOCUMENT_MODES as readonly string[]).includes(value);
}

export function isTextBlockName(value: string): value is TextBlockName {
  return (TEXT_BLOCKS as readonly string[]).includes(value);
}
