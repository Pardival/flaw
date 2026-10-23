/** Budget AC-087 : moins de 16 ms par frappe. */
export const KEYSTROKE_BUDGET_MS = 16;

/**
 * Le banc tourne sur un Xeon virtualisé, pas sur un téléphone.
 * Facteur prudent : un milieu de gamme est compté trois fois plus lent
 * pour le JS et la mise en page locale.
 */
export const PHONE_SLOWDOWN = 3;

export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("aucun échantillon");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  const value = sorted[rank];
  if (value === undefined) throw new Error("percentile vide");
  return value;
}

/** Niveau 1 seulement si le pire centile, ramené au téléphone, reste sous le budget. */
export function levelFromP95(p95Ms: number): 1 | 2 {
  return p95Ms * PHONE_SLOWDOWN < KEYSTROKE_BUDGET_MS ? 1 : 2;
}
