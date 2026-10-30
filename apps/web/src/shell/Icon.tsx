/**
 * Icônes de Flaw : trait de 1,6 px sur une grille de 20, coins arrondis, couleur
 * du texte. Dessinées pour l'application (aucune bibliothèque externe).
 */
export type IconName =
  | "chapter"
  | "image"
  | "cover"
  | "focus"
  | "type"
  | "export"
  | "more"
  | "search"
  | "jump"
  | "history"
  | "keyboard"
  | "rename"
  | "trash"
  | "check"
  | "open"
  | "close"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignJustify"
  | "crop";

export const ICON_PATHS: Record<IconName, string> = {
  // Page avec un signet : nouveau chapitre.
  chapter: "M5 3.5h7l3 3v10h-10z M12 3.5v3h3 M8 10h4 M10 8v4",
  image: "M3.5 4.5h13v11h-13z M3.5 13l3.8-3.8 3 3 2-2 4.2 4.2 M13 7.8a.01.01 0 1 0 .02 0",
  // Livre fermé vu de face : couverture.
  cover: "M5.5 3.5h9.5v13h-9.5a1.5 1.5 0 0 1-1.5-1.5v-10a1.5 1.5 0 0 1 1.5-1.5z M7.5 7h5 M7.5 9.5h3.5 M4 15a1.5 1.5 0 0 1 1.5-1.5h9.5",
  focus: "M3.5 7.5v-4h4 M12.5 3.5h4v4 M16.5 12.5v4h-4 M7.5 16.5h-4v-4 M8 10h4",
  type: "M3.5 15.5l4-11 4 11 M5 11.5h5 M13 11h3.5 M13 15.5h3.5 M14.75 11v4.5",
  export: "M10 3.5v9 M6.5 7l3.5-3.5 3.5 3.5 M4.5 11.5v4h11v-4",
  more: "M5 10h.01 M10 10h.01 M15 10h.01",
  search: "M8.5 14a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z M12.5 12.5l4 4",
  jump: "M4 5h12 M4 10h8 M4 15h12 M14 8l2.5 2-2.5 2",
  history: "M3.5 10a6.5 6.5 0 1 0 2-4.7 M3.5 3.5v3h3 M10 6.5v3.8l2.5 1.5",
  keyboard: "M2.5 5.5h15v9h-15z M5.5 8.5h.01 M8.5 8.5h.01 M11.5 8.5h.01 M14.5 8.5h.01 M6.5 11.5h7",
  rename: "M4 16l1-4 8.5-8.5 3 3-8.5 8.5z M11.5 5.5l3 3",
  trash: "M4 6h12 M8 6v-2h4v2 M5.5 6l.8 10h7.4l.8-10",
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  open: "M8.5 4.5h-4v11h11v-4 M11.5 3.5h5v5 M16.5 3.5l-7 7",
  close: "M5 5l10 10 M15 5l-10 10",
  alignLeft: "M3.5 5h13 M3.5 8.5h8 M3.5 12h13 M3.5 15.5h8",
  alignCenter: "M3.5 5h13 M6 8.5h8 M3.5 12h13 M6 15.5h8",
  alignRight: "M3.5 5h13 M8.5 8.5h8 M3.5 12h13 M8.5 15.5h8",
  alignJustify: "M3.5 5h13 M3.5 8.5h13 M3.5 12h13 M3.5 15.5h13",
  crop: "M5.5 2.5v12h12 M2.5 5.5h12v12",
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const dots = name === "more";
  return (
    <svg className="flaw-icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d={ICON_PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={dots ? 2.6 : 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Même icône, construite hors React (vues ProseMirror). */
export function iconElement(name: IconName, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "flaw-icon");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICON_PATHS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
