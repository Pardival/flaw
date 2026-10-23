/**
 * Alerte d'administration (SEC-AUTH-08). Le corps est le nom d'action,
 * jamais un mot de passe, un secret ou un contenu.
 */
const ALERTED = new Set([
  "admin.create_user",
  "admin.reset_password",
  "admin.disable_mfa",
  "admin.revoke_sessions",
  "admin.revoke_dek",
  "admin.rotate_kek",
]);

export function commandAlerts(action: string): boolean {
  return ALERTED.has(action);
}

export async function alertAdmin(url: string, action: string): Promise<void> {
  if (url === "" || !commandAlerts(action)) {
    return;
  }
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: action,
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
}
