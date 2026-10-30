/**
 * Cible de construction. `desktop` : application de bureau 100 % locale,
 * sans compte, sans serveur ni synchronisation ; IndexedDB est la seule source.
 * Vite remplace la constante au build, le code serveur est alors éliminé.
 */
export const LOCAL_ONLY: boolean = import.meta.env.VITE_FLAW_TARGET === "desktop";
