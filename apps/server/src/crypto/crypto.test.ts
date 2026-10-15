import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { deriveIdentifierHmacKey, deriveRecoveryCodeKey } from "@flaw/crypto";

import { validateKeyMaterial } from "../platform/healthz.ts";
import { loadKekFile, peppersMatchKek } from "./kek.ts";
import { PurgeRefusee, consignerResultatPurge } from "./purge.ts";

const directories: string[] = [];
const cryptoRoot = fileURLToPath(new URL(".", import.meta.url));

function validKey(): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const encoded = randomBytes(32).toString("base64");
    if (validateKeyMaterial(`${encoded}\n`) === null) {
      return encoded;
    }
  }
  throw new Error("aucune cle de test");
}

function writeKey(contents: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "flaw-kek-"));
  directories.push(directory);
  const filePath = join(directory, "flaw_kek");
  writeFileSync(filePath, contents);
  chmodSync(filePath, mode);
  return filePath;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SEC-SECRET-07 — flaw_kek via le validateur T-002", () => {
  it("retire un seul \\n ou \\r\\n final et décode 32 octets", () => {
    const encoded = validKey();
    for (const suffix of ["\n", "\r\n"]) {
      const loaded = loadKekFile(writeKey(`${encoded}${suffix}`));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.kek.length).toBe(32);
        expect(Buffer.from(loaded.kek).toString("base64")).toBe(encoded);
      }
    }
  });

  it("laisse le second \\n et refuse", () => {
    const loaded = loadKekFile(writeKey(`${validKey()}\n\n`));
    expect(loaded).toEqual({ ok: false, message: "refus de démarrer : secret invalide" });
  });

  it("compte l'espace final (non retiré) et refuse la matière qui n'est plus du base64", () => {
    const loaded = loadKekFile(writeKey(`${validKey()} `));
    expect(loaded).toEqual({ ok: false, message: "refus de démarrer : kek" });
  });

  it("refuse 31 octets décodés, trop peu de caractères distincts, un mot interdit et un fichier 644", () => {
    let short = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = randomBytes(31).toString("base64");
      if (validateKeyMaterial(candidate) === "kek") {
        short = candidate;
        break;
      }
    }
    expect(short.length).toBeGreaterThan(0);
    expect(loadKekFile(writeKey(short)).ok).toBe(false);

    expect(loadKekFile(writeKey("ab".repeat(16))).ok).toBe(false);

    const banned = `${validKey().slice(0, 20)}TEST${validKey().slice(24)}`;
    expect(loadKekFile(writeKey(banned)).ok).toBe(false);

    const world = loadKekFile(writeKey(validKey(), 0o644));
    expect(world).toEqual({ ok: false, message: "refus de démarrer : secret lisible par tous" });
  });

  it("ne réécrit pas la liste de mots interdits", () => {
    const source = ["kek.ts", "purge.ts", "index.ts"]
      .map((name) => readFileSync(join(cryptoRoot, name), "utf8"))
      .join("\n");
    expect(source).toContain("readSecretFile");
    expect(source).not.toContain("motdepasse");
  });
});

describe("purge_journaux — codes en clair dans audit_events", () => {
  const ownerId = "11111111-1111-7111-8111-111111111111";
  const auditId = "33333333-3333-7333-8333-333333333333";

  function capture() {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const query = (sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rowCount: 1 });
    };
    return { calls, query };
  }

  it("écrit ok et les UUID, sans champ chiffré ni contenu", async () => {
    const { calls, query } = capture();
    const row = await consignerResultatPurge({
      query,
      purge: () => Promise.resolve(),
      ownerId,
      id: auditId,
    });
    expect(row).toEqual({ id: auditId, ownerId, eventType: "purge_journaux", result: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(
      "INSERT INTO flaw.audit_events (id, owner_id, event_type, result) VALUES ($1, $2, $3, $4)",
    );
    expect(calls[0]?.params).toEqual([auditId, ownerId, "purge_journaux", "ok"]);
    const stored = calls[0]?.params[3];
    expect(stored).toBe("ok");
    expect(typeof stored).toBe("string");
    expect(stored).not.toMatch(/ct|nonce|cipher|wrapped|contenu|label/i);
  });

  it("écrit refus ou erreur, puis relance", async () => {
    const refused = capture();
    await expect(
      consignerResultatPurge({
        query: refused.query,
        purge: () => Promise.reject(new PurgeRefusee()),
        ownerId,
        id: auditId,
      }),
    ).rejects.toBeInstanceOf(PurgeRefusee);
    expect(refused.calls[0]?.params).toEqual([auditId, ownerId, "purge_journaux", "refus"]);

    const failed = capture();
    await expect(
      consignerResultatPurge({
        query: failed.query,
        purge: () => Promise.reject(new Error("purge")),
        ownerId,
        id: auditId,
      }),
    ).rejects.toThrow("purge");
    expect(failed.calls[0]?.params).toEqual([auditId, ownerId, "purge_journaux", "erreur"]);
  });

  it("le module n'écrit aucun champ chiffré ni contenu utilisateur", () => {
    const source = readFileSync(join(cryptoRoot, "purge.ts"), "utf8");
    expect(source).not.toMatch(/seal|unwrap|wrapDek|ciphertext|nonce|base64/);
    expect(source).toContain('"ok"');
    expect(source).toContain('"refus"');
    expect(source).toContain('"erreur"');
  });
});

describe("poivres hmac_pepper et recovery_pepper", () => {
  function writeNamed(name: string, contents: string): string {
    const directory = mkdtempSync(join(tmpdir(), "flaw-pepper-"));
    directories.push(directory);
    const filePath = join(directory, name);
    writeFileSync(filePath, contents);
    chmodSync(filePath, 0o600);
    return filePath;
  }

  it("dérive chaque poivre depuis son fichier, jamais depuis la KEK", () => {
    const kek = validKey();
    const hmac = validKey();
    const recovery = validKey();
    const loadedHmac = loadKekFile(writeNamed("hmac_pepper", `${hmac}\n`));
    const loadedRecovery = loadKekFile(writeNamed("recovery_pepper", `${recovery}\n`));
    const loadedKek = loadKekFile(writeNamed("flaw_kek", `${kek}\n`));
    expect(loadedHmac.ok && loadedRecovery.ok && loadedKek.ok).toBe(true);
    if (!loadedHmac.ok || !loadedRecovery.ok || !loadedKek.ok) {
      return;
    }
    const identifiants = deriveIdentifierHmacKey(loadedHmac.kek, "pep-hmac-2026-10");
    const secours = deriveRecoveryCodeKey(loadedRecovery.kek, "pep-2026-10");
    expect(identifiants.length).toBe(32);
    expect(secours.length).toBe(32);
    expect(Buffer.from(identifiants).equals(Buffer.from(secours))).toBe(false);
    expect(peppersMatchKek(kek, hmac, recovery)).toBe(false);
    loadedHmac.kek.fill(0);
    loadedRecovery.kek.fill(0);
    loadedKek.kek.fill(0);
  });

  it("refuse de démarrer si un poivre égale la KEK", () => {
    const kek = validKey();
    const other = validKey();
    expect(peppersMatchKek(kek, kek, other)).toBe(true);
    expect(peppersMatchKek(kek, other, kek)).toBe(true);
    expect(peppersMatchKek(kek, other, validKey())).toBe(false);
    expect(peppersMatchKek(kek, other, other)).toBe(true);
    const source = readFileSync(join(cryptoRoot, "kek.ts"), "utf8");
    expect(source).toContain("decoded.fill(0)");
  });
});

describe("AC-102", () => {
  it("ne référence aucun traceur", () => {
    const files: string[] = [];
    for (const entry of readdirSync(cryptoRoot)) {
      const path = join(cryptoRoot, entry);
      if (statSync(path).isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) {
        files.push(readFileSync(path, "utf8"));
      }
    }
    const source = files.join("\n");
    for (const host of ["google-analytics", "googletagmanager", "segment.io", "plausible.io", "doubleclick.net"]) {
      expect(source).not.toContain(host);
    }
  });
});
