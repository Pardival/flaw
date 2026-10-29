/**
 * Corps et requêtes des routes documents (API-009 à API-015).
 * id client uniquement à la création (UUIDv7). Les autres identités restent serveur.
 */
import { z } from "zod";

export const MODES = ["novel", "screenplay", "document", "blank"] as const;
export const PAGE_FORMATS = ["novel_13x20", "pocket_11x17_8", "trade_15x23", "a5", "a4", "us_letter"] as const;
export const CONTENT_FORMATS = ["prosemirror-json", "text", "markdown"] as const;

export type DocumentMode = (typeof MODES)[number];
export type PageFormat = (typeof PAGE_FORMATS)[number];
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

const uuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());

export const documentCreateSchema = z
  .object({
    id: uuidV7,
    title: z.string().max(300).optional(),
    mode: z.enum(MODES),
    pageFormat: z.enum(PAGE_FORMATS).optional(),
    fontFamily: z.string().min(1).max(200).optional(),
    importedFrom: z.enum(["docx", "txt", "md"]).optional(),
  })
  .strict();

export const documentPatchSchema = z
  .object({
    title: z.string().max(300).optional(),
    // Changement de mode (AC-005) : ajout au contrat 0.4.18, rétrocompatible.
    mode: z.enum(MODES).optional(),
    pageFormat: z.enum(PAGE_FORMATS).optional(),
    fontFamily: z.string().min(1).max(200).optional(),
    baseFontSizePt: z.number().min(6).max(48).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export type DocumentCreate = z.infer<typeof documentCreateSchema>;
export type DocumentPatch = z.infer<typeof documentPatchSchema>;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseDateTime(value: string): Date | undefined {
  if (!DATE_TIME.test(value)) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}
