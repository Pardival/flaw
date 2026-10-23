/**
 * Point d'entrée historique. La commande vit dans admin-cli/.
 */
import { pathToFileURL } from "node:url";

import { main } from "../admin-cli/cli.ts";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "echec";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
