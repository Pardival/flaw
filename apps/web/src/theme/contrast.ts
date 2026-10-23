/** Contraste WCAG 2.x (luminance relative). Sert à vérifier les jetons AA. */

function channel(value: number): number {
  const srgb = value / 255;
  if (srgb <= 0.04045) {
    return srgb / 12.92;
  }
  return ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error("couleur hex attendue");
  }
  const rgb = Number.parseInt(normalized, 16);
  const red = channel((rgb >> 16) & 255);
  const green = channel((rgb >> 8) & 255);
  const blue = channel(rgb & 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
