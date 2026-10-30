/** Limites centralisées (SEC-IMP-03, SEC-IMP-04), alignées sur SEC-API-03 (10 Mo d'état). */
export const LIMITS = {
  textFileBytes: 10 * 1024 * 1024,
  docxFileBytes: 20 * 1024 * 1024,
  pdfFileBytes: 50 * 1024 * 1024,
  pdfPages: 2000,
  outputBytes: 10 * 1024 * 1024,
  zipTotalBytes: 100 * 1024 * 1024,
  zipPartBytes: 50 * 1024 * 1024,
  zipRatio: 100,
  zipEntries: 1000,
  zipPathDepth: 8,
  zipPathLength: 255,
  xmlDepth: 256,
  xmlAttributes: 64,
  markdownNesting: 20,
  timeoutMs: 30_000,
} as const;
