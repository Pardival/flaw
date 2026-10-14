import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_TYPE,
  CryptoError,
  deriveIdentifierHmacKey,
  deriveRecoveryCodeKey,
  generateDek,
  wrapDek,
} from "@flaw/crypto";

import { validateKeyMaterial } from "../platform/healthz.ts";
import { decodeValidatedKey, loadKekFile } from "./kek.ts";
import { consignerResultatPurge, lireResultatPurge } from "./purge.ts";

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

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    return (error as CryptoError).code;
  }
  throw new Error("exception attendue");
}

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

describe("purge_journaux — écriture chiffrée dans audit_events", () => {
  const userId = "11111111-1111-7111-8111-111111111111";
  const keyId = "22222222-2222-7222-8222-222222222222";
  const auditId = "33333333-3333-7333-8333-333333333333";

  function materiau() {
    const kek = decodeValidatedKey(validKey());
    if (kek === null) {
      throw new Error("kek");
    }
    const dek = generateDek();
    const wrapped = wrapDek(kek, "kek-2026-10", userId, dek);
    return { kek, dek, wrapped };
  }

  it("chiffre le résultat et l'insère sans clair", async () => {
    const { kek, dek, wrapped } = materiau();
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    let purged = false;
    const row = await consignerResultatPurge({
      query: (sql, params) => {
        calls.push({ sql, params });
        return Promise.resolve({ rowCount: 1 });
      },
      purge: () => {
        purged = true;
        return Promise.resolve();
      },
      kek,
      userId,
      keyId,
      wrapped,
      id: auditId,
    });
    expect(purged).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(
      "INSERT INTO flaw.audit_events (id, owner_id, event_type, result) VALUES ($1, $2, $3, $4)",
    );
    expect(calls[0]?.params.slice(0, 3)).toEqual([auditId, userId, "purge_journaux"]);
    const stored = String(calls[0]?.params[3]);
    expect(stored).toBe(row.result);
    expect(stored).not.toContain("purge_journaux");
    expect(stored).not.toContain("statut");
    expect(stored).not.toContain(Buffer.from(kek).toString("base64"));
    expect(stored).not.toContain(Buffer.from(dek).toString("base64"));
    const opened = lireResultatPurge({
      id: auditId,
      ownerId: userId,
      result: stored,
      resolveDek: (id) => (id === keyId ? dek : undefined),
    });
    expect(Buffer.from(opened).toString("utf8")).toBe(
      JSON.stringify({ fonction: "purge_journaux", id: auditId, statut: "ok" }),
    );
  });

  it("n'écrit rien si la purge échoue, ni si la DEK ne se dévoile pas", async () => {
    const { kek, wrapped } = materiau();
    let queries = 0;
    await expect(
      consignerResultatPurge({
        query: () => {
          queries += 1;
          return Promise.resolve();
        },
        purge: () => Promise.reject(new Error("purge")),
        kek,
        userId,
        keyId,
        wrapped,
        id: auditId,
      }),
    ).rejects.toThrow("purge");
    expect(queries).toBe(0);

    let purged = false;
    await expect(
      consignerResultatPurge({
        query: () => Promise.resolve(),
        purge: () => {
          purged = true;
          return Promise.resolve();
        },
        kek,
        userId: "autre-utilisateur",
        keyId,
        wrapped,
        id: auditId,
      }),
    ).rejects.toBeInstanceOf(CryptoError);
    expect(purged).toBe(false);
  });

  it("refuse un tag altéré, une mauvaise clé et un key_id inconnu", async () => {
    const { kek, dek, wrapped } = materiau();
    const row = await consignerResultatPurge({
      query: () => Promise.resolve(),
      purge: () => Promise.resolve(),
      kek,
      userId,
      keyId,
      wrapped,
      id: auditId,
    });
    const parsed = JSON.parse(row.result) as { ct: string };
    const ct = Buffer.from(parsed.ct, "base64");
    ct[ct.length - 1] ^= 1;
    parsed.ct = ct.toString("base64");
    const altere = JSON.stringify(parsed);
    expect(code(() => lireResultatPurge({
      id: auditId,
      ownerId: userId,
      result: altere,
      resolveDek: (id) => (id === keyId ? dek : undefined),
    }))).toBe("authentication_failed");

    const autre = generateDek();
    expect(code(() => lireResultatPurge({
      id: auditId,
      ownerId: userId,
      result: row.result,
      resolveDek: (id) => (id === keyId ? autre : undefined),
    }))).toBe("authentication_failed");

    expect(code(() => lireResultatPurge({
      id: auditId,
      ownerId: userId,
      result: row.result,
      resolveDek: () => undefined,
    }))).toBe("unknown_key_id");
  });

  it("lie le résultat au propriétaire et au type audit", async () => {
    const { kek, dek, wrapped } = materiau();
    const row = await consignerResultatPurge({
      query: () => Promise.resolve(),
      purge: () => Promise.resolve(),
      kek,
      userId,
      keyId,
      wrapped,
      id: auditId,
    });
    expect(code(() => lireResultatPurge({
      id: auditId,
      ownerId: "99999999-9999-7999-8999-999999999999",
      result: row.result,
      resolveDek: (id) => (id === keyId ? dek : undefined),
    }))).toBe("authentication_failed");
    expect(CONTENT_TYPE.audit).toBe("audit");
  });
});

describe("poivres — même décodeur que la KEK", () => {
  it("dérive HMAC et codes de secours depuis le secret validé", () => {
    const encoded = validKey();
    const loaded = loadKekFile(writeKey(`${encoded}\n`));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const identifiants = deriveIdentifierHmacKey(loaded.kek, "pep-hmac-2026-10");
    const secours = deriveRecoveryCodeKey(loaded.kek, "pep-2026-10");
    expect(identifiants.length).toBe(32);
    expect(secours.length).toBe(32);
    expect(Buffer.from(identifiants).equals(Buffer.from(secours))).toBe(false);
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
