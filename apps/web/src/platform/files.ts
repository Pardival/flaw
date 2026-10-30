/**
 * Enregistrer un fichier sur la machine. Dans l'application de bureau, la
 * fenêtre native « Enregistrer sous » ; dans le navigateur, un téléchargement.
 * Le contenu ne quitte jamais l'appareil.
 */
type TauriInternals = { invoke: (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<unknown> };

function tauri(): TauriInternals | null {
  const internals = (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals ?? null;
}

export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && tauri() !== null;
}

/** `true` si le fichier est enregistré, `false` si la personne a annulé. */
export async function saveFile(bytes: Uint8Array, name: string, mime: string): Promise<boolean> {
  const shell = tauri();
  if (shell !== null) {
    // Corps brut (pas de JSON) : le nom passe en en-tête, encodé.
    const saved = await shell.invoke("save_file", bytes, { headers: { "x-flaw-name": encodeURIComponent(name) } });
    return saved === true;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
