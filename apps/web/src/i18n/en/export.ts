import type { exportCatalog as fr } from "../fr/export.ts";
import type { Catalog } from "./catalog.ts";

export const exportCatalog: Catalog<typeof fr> = {
  cover: "Cover",
  includeCover: "Include the front and back cover",
  editCover: "Edit the cover…",
  createCover: "Create a cover…",
  title: "Export",
  format: "Format",
  kind_pdf: "PDF",
  kind_docx: "Word",
  kind_epub: "EPUB",
  kind_fountain: "Fountain",
  hint_pdf: "book layout, ready to print",
  hint_docx: "to keep editing in a word processor",
  hint_epub: "for e-readers",
  hint_fountain: "plain text for screenwriting software",
  pdfOptions: "PDF options",
  mirrorMargins: "Mirrored margins (double-sided)",
  chaptersOnRecto: "Chapters start on a right-hand page",
  export: "Export",
  busy: "Creating the file…",
  cancel: "Cancel",
  failed: "The export failed. Try again.",
  pdfFailed: "The PDF could not be created. You can export to Word instead.",
  tryWord: "Export to Word",
};
