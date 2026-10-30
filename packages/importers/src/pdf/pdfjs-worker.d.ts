// Le moteur de pdf.js n'a pas de types publiés : seul son gestionnaire de messages nous sert.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
