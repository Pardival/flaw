/**
 * Handshake WebSocket : origine, chemin, schéma. Pas de bibliothèque Yjs.
 */
import { describe, expect, it } from "vitest";

import { messageTooLarge, revalidationDelayMs, upgradeRefusal } from "./upgrade.ts";

const allowed = new Set(["https://flaw.test"]);

describe("handshake /api/v1/sync", () => {
  it("refuse une origine étrangère, un autre chemin et un client trop ancien", () => {
    expect(
      upgradeRefusal(
        { path: "/api/v1/sync", origin: "https://evil.example", schemaHeader: "1", documentSchema: 1 },
        allowed,
      ),
    ).toBe(403);
    expect(
      upgradeRefusal(
        { path: "/api/v1/autre", origin: "https://flaw.test", schemaHeader: "1", documentSchema: 1 },
        allowed,
      ),
    ).toBe(403);
    expect(
      upgradeRefusal({ path: "/api/v1/sync", origin: undefined, schemaHeader: "1", documentSchema: 1 }, allowed),
    ).toBe(403);
    expect(
      upgradeRefusal({ path: "/api/v1/sync", origin: "https://flaw.test", schemaHeader: undefined, documentSchema: 1 }, allowed),
    ).toBe(426);
    expect(
      upgradeRefusal({ path: "/api/v1/sync", origin: "https://flaw.test", schemaHeader: "0", documentSchema: 1 }, allowed),
    ).toBe(426);
    expect(
      upgradeRefusal({ path: "/api/v1/sync", origin: "https://flaw.test", schemaHeader: "1", documentSchema: 2 }, allowed),
    ).toBe(426);
  });

  it("accepte un client au niveau du texte ou plus récent, et borne la revalidation", () => {
    expect(
      upgradeRefusal({ path: "/api/v1/sync", origin: "https://flaw.test", schemaHeader: "1", documentSchema: 1 }, allowed),
    ).toBeUndefined();
    expect(
      upgradeRefusal({ path: "/api/v1/sync", origin: "https://flaw.test", schemaHeader: "2", documentSchema: 1 }, allowed),
    ).toBeUndefined();
    expect(revalidationDelayMs(30)).toBe(30_000);
    expect(revalidationDelayMs(0)).toBe(30_000);
    expect(messageTooLarge(11, 10)).toBe(true);
    expect(messageTooLarge(10, 10)).toBe(false);
  });
});
