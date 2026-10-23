/**
 * Corps JSON des routes de textes. owner_id n'y figure pas : la couche le pose.
 */
import { z } from "zod";

export const documentRefSchema = z.object({ id: z.uuid() }).strict();

export const documentFontSchema = z.object({ font: z.string().min(1).max(80) }).strict();

export const syncBodySchema = z.object({}).strict();
