import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COLUMN,
  CryptoError,
  DERIVED_KEY_LENGTH,
  ENC_VERSION,
  KEY_LENGTH,
  contentAad,
  dekAad,
  deriveIdentifierHmacKey,
  deriveRecoveryCodeKey,
  generateDek,
  hkdfSha256,
  openContent,
  openXChaCha,
  sealContent,
  sealXChaCha,
  unwrapDek,
  wrapDek,
} from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function octets(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sources(path));
    } else if (path.endsWith(".ts")) {
      files.push(readFileSync(path, "utf8"));
    }
  }
  return files;
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    return (error as CryptoError).code;
  }
  throw new Error("exception attendue");
}

describe("HKDF-SHA-256 — RFC 5869", () => {
  it("reproduit le cas 1 (sel fourni, L = 42)", () => {
    const okm = hkdfSha256(
      octets("0b".repeat(22)),
      octets("f0f1f2f3f4f5f6f7f8f9"),
      42,
      octets("000102030405060708090a0b0c"),
    );
    expect(hex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("reproduit le cas 3 (sel absent, L = 42)", () => {
    const okm = hkdfSha256(octets("0b".repeat(22)), new Uint8Array(), 42);
    expect(hex(okm)).toBe(
      "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    );
  });
});

describe("HKDF — dérivations Flaw", () => {
  const pepper = octets("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

  it("dérive la clé HMAC des identifiants (vecteur figé)", () => {
    const derived = deriveIdentifierHmacKey(pepper, "pep-hmac-vecteur-1");
    expect(derived.length).toBe(DERIVED_KEY_LENGTH);
    expect(hex(derived)).toBe("a87a5ab0e5693726ea63e40cb65826db845c362178654c196ea8ad6a953ff201");
  });

  it("dérive la clé des codes de secours G13/H1 (vecteur figé)", () => {
    const derived = deriveRecoveryCodeKey(pepper, "pep-2026-10");
    expect(hex(derived)).toBe("404c3d4057b9f6909229248cc67e6aa67e506826c3b2546d809718ecaa7c082d");
  });

  it("sépare les domaines et les identifiants", () => {
    const identifiants = deriveIdentifierHmacKey(pepper, "pep-2026-10");
    const secours = deriveRecoveryCodeKey(pepper, "pep-2026-10");
    const autre = deriveIdentifierHmacKey(pepper, "pep-autre");
    expect(hex(identifiants)).not.toBe(hex(secours));
    expect(hex(identifiants)).not.toBe(hex(autre));
  });

  it("refuse un poivre qui n'est pas 32 octets", () => {
    expect(code(() => deriveIdentifierHmacKey(octets("00".repeat(31)), "pep-2026-10"))).toBe(
      "invalid_key_length",
    );
  });

  it("fige le sel omis : il vaut HashLen octets nuls (RFC 5869)", () => {
    const info = new TextEncoder().encode("flaw/hmac-identifiants/v1|pep-hmac-vecteur-1");
    const omitted = hkdfSha256(pepper, info, 32);
    const zeros = hkdfSha256(pepper, info, 32, new Uint8Array(32));
    expect(hex(omitted)).toBe("a87a5ab0e5693726ea63e40cb65826db845c362178654c196ea8ad6a953ff201");
    expect(hex(zeros)).toBe(hex(omitted));
  });
});

describe("XChaCha20-Poly1305 — draft-irtf-cfrg-xchacha-03 A.3.1", () => {
  const clef = octets("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  const nonce = octets("404142434445464748494a4b4c4d4e4f5051525354555657");
  const aad = octets("50515253c0c1c2c3c4c5c6c7");
  const clair = octets(
    "4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e",
  );
  const chiffre = octets(
    "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49",
  );

  it("chiffre le vecteur officiel (chiffré ‖ tag)", () => {
    expect(hex(sealXChaCha(clef, nonce, clair, aad))).toBe(hex(chiffre));
  });

  it("déchiffre le vecteur officiel", () => {
    expect(hex(openXChaCha(clef, nonce, chiffre, aad))).toBe(hex(clair));
  });

  it("refuse un tag altéré", () => {
    const altere = new Uint8Array(chiffre);
    altere[altere.length - 1] ^= 0x01;
    expect(code(() => openXChaCha(clef, nonce, altere, aad))).toBe("authentication_failed");
  });

  it("refuse un nonce altéré", () => {
    const altere = new Uint8Array(nonce);
    altere[0] ^= 0x01;
    expect(code(() => openXChaCha(clef, altere, chiffre, aad))).toBe("authentication_failed");
  });

  it("refuse une mauvaise clé", () => {
    const autre = new Uint8Array(clef);
    autre[0] ^= 0x01;
    expect(code(() => openXChaCha(autre, nonce, chiffre, aad))).toBe("authentication_failed");
  });
});

describe("enveloppe KEK → DEK → contenu", () => {
  const kek = octets("11".repeat(32));
  const userId = "11111111-1111-7111-8111-111111111111";
  const kekId = "kek-2026-10";
  const rowA = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const rowB = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const clairA = utf8Clair("texte-synthetique-a");
  const clairB = utf8Clair("texte-synthetique-b");

  function trousseau(dek: Uint8Array, keyId: string): (id: string) => Uint8Array | undefined {
    return (id) => (id === keyId ? dek : undefined);
  }

  it("fige l'encodage AAD : domaine, puis uint32be et UTF-8", () => {
    expect(hex(contentAad({ rowId: rowA, column: COLUMN.labelCt }))).toBe(
      "666c61772f6161642f76310000002461616161616161612d616161612d376161612d386161612d616161616161616161616161000000086c6162656c5f6374",
    );
    expect(hex(dekAad(userId, kekId))).toBe(
      "666c61772f64656b2d6161642f76310000002431313131313131312d313131312d373131312d383131312d3131313131313131313131310000000b6b656b2d323032362d3130",
    );
  });

  it("enveloppe une DEK et retrouve le clair lié à la colonne", () => {
    const dek = generateDek();
    const keyId = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
    const wrapped = wrapDek(kek, kekId, userId, dek);
    expect(wrapped.encVersion).toBe(ENC_VERSION);
    expect(wrapped.keyId).toBe(kekId);
    expect(wrapped.status).toBe("active");
    expect(wrapped.wrappedNonce.length).toBe(24);
    expect(hex(unwrapDek(kek, userId, wrapped))).toBe(hex(dek));
    const binding = { rowId: rowA, column: COLUMN.labelCt };
    const sealed = sealContent(dek, keyId, binding, clairA);
    const opened = openContent(binding, sealed, trousseau(dek, keyId));
    expect(hex(opened)).toBe(hex(clairA));
    expect(hex(wrapped.wrappedCt)).not.toContain(hex(kek));
    expect(hex(sealed.ciphertext)).not.toContain(hex(kek));
    expect(hex(sealed.ciphertext)).not.toContain(hex(dek));
  });

  it("échoue si le chiffré label_ct est déplacé vers une autre ligne", () => {
    const dek = octets("22".repeat(32));
    const keyId = "dek-a";
    const sealed = sealContent(
      dek,
      keyId,
      { rowId: rowA, column: COLUMN.labelCt },
      clairA,
      octets("33".repeat(24)),
    );
    expect(
      code(() =>
        openContent({ rowId: rowB, column: COLUMN.labelCt }, sealed, trousseau(dek, keyId)),
      ),
    ).toBe("authentication_failed");
    expect(
      code(() =>
        openContent({ rowId: rowA, column: COLUMN.versionCt }, sealed, trousseau(dek, keyId)),
      ),
    ).toBe("authentication_failed");
    expect(hex(clairB)).not.toBe(hex(clairA));
  });

  it("refuse un key_id inconnu", () => {
    const dek = octets("22".repeat(32));
    const binding = { rowId: rowA, column: COLUMN.labelCt };
    const sealed = sealContent(dek, "dek-connu", binding, clairA, octets("44".repeat(24)));
    expect(code(() => openContent(binding, sealed, () => undefined))).toBe("unknown_key_id");
  });

  it("refuse une DEK de mauvaise longueur, un nonce court et une version inconnue", () => {
    expect(code(() => sealXChaCha(octets("00".repeat(31)), octets("00".repeat(24)), clairA, new Uint8Array()))).toBe(
      "invalid_key_length",
    );
    expect(code(() => sealXChaCha(kek, octets("00".repeat(23)), clairA, new Uint8Array()))).toBe("invalid_nonce");
    const dek = octets("22".repeat(32));
    const binding = { rowId: rowA, column: COLUMN.stateCt };
    const sealed = sealContent(dek, "dek-connu", binding, clairA, octets("55".repeat(24)));
    expect(
      code(() => openContent(binding, { ...sealed, encVersion: 2 }, trousseau(dek, "dek-connu"))),
    ).toBe("unsupported_version");
  });

  it("lie la DEK à l'utilisateur et à key_id", () => {
    const dek = octets("66".repeat(32));
    const wrapped = wrapDek(kek, kekId, userId, dek, octets("77".repeat(24)));
    expect(code(() => unwrapDek(kek, "autre-utilisateur", wrapped))).toBe("authentication_failed");
    expect(code(() => unwrapDek(kek, userId, { ...wrapped, keyId: "kek-autre" }))).toBe(
      "authentication_failed",
    );
    expect(unwrapDek(kek, userId, wrapped).length).toBe(KEY_LENGTH);
  });
});

describe("AC-102, AC-094, SEC-DATA-07, SEC-DATA-09", () => {
  const src = sources(join(root, "src")).join("\n");

  it("AC-102 : aucun hôte d'analytique dans le paquet", () => {
    for (const host of ["google-analytics", "googletagmanager", "segment.io", "plausible.io", "doubleclick.net"]) {
      expect(src).not.toContain(host);
    }
    expect(src).not.toContain("fetch(");
  });

  it("AC-094 : le paquet n'écrit pas la KEK", () => {
    expect(src).not.toContain("writeFile");
    expect(src).not.toContain("node:fs");
    expect(src).not.toContain("pg_dump");
  });

  it("SEC-DATA-07 : le paquet n'importe pas node:", () => {
    expect(src).not.toContain("node:");
  });

  it("SEC-DATA-09 : le clair d'essai est synthétique et hors du paquet", () => {
    const tests = readFileSync(fileURLToPath(new URL("./vectors.test.ts", import.meta.url)), "utf8");
    expect(tests).toContain("texte-synthetique-a");
    expect(src).not.toContain("texte-synthetique-a");
  });
});

function utf8Clair(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
