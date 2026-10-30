import type { theme as fr } from "../fr/theme.ts";
import type { Catalog } from "./catalog.ts";

export const theme: Catalog<typeof fr> = {
  themeToLight: "Switch to light theme",
  themeToDark: "Switch to dark theme",
};
