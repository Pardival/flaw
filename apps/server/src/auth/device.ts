/**
 * Résumé d'appareil : navigateur et système seulement.
 * Aucune localisation (ni pays, ni ville, ni coordonnées).
 */
export type DeviceSummary = {
  browser: string;
  os: string;
};

export function summarizeDevice(userAgent: string | null | undefined): DeviceSummary {
  const ua = userAgent ?? "";
  let browser = "inconnu";
  if (ua.includes("Edg/")) {
    browser = "Edge";
  } else if (ua.includes("Firefox/")) {
    browser = "Firefox";
  } else if (ua.includes("Chrome/") || ua.includes("CriOS/")) {
    browser = "Chrome";
  } else if (ua.includes("Safari/")) {
    browser = "Safari";
  }
  let os = "inconnu";
  if (ua.includes("Android")) {
    os = "Android";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  } else if (ua.includes("Windows")) {
    os = "Windows";
  } else if (ua.includes("Mac OS")) {
    os = "macOS";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }
  return { browser, os };
}

export function deviceLabel(device: DeviceSummary): string {
  return `${device.browser}/${device.os}`;
}
