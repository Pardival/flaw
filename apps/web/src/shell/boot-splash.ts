/**
 * Écran de chargement : le logo est déjà dans index.html (première image, sans attendre
 * le script). L'app le retire en fondu dès que l'écran à montrer est prêt dessous.
 */
const LEAVE_MS = 380;

export function hideBootSplash(): void {
  if (typeof document === "undefined") {
    return;
  }
  const splash = document.getElementById("boot-splash");
  if (splash === null || splash.dataset.leaving === "true") {
    return;
  }
  splash.dataset.leaving = "true";
  window.setTimeout(() => splash.remove(), LEAVE_MS);
}
