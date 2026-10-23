import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { alertAdmin } from "./alert.ts";

describe("alerte admin", () => {
  it("abandonne un webhook muet au bout de 5 s", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("port");
    }
    const started = Date.now();
    await alertAdmin(`http://127.0.0.1:${address.port}/`, "admin.create_user");
    const elapsed = Date.now() - started;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(12_000);
  }, 15_000);
});
