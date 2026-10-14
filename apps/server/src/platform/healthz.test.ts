import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  readSecretFile,
  resolvedClientIp,
  stripCrLf,
  validateKeyMaterial,
  validateSecret,
  worldReadable,
} from "./healthz.ts";

const HEX = "0123456789abcdef0123456789abcdef";

describe("validateur de secrets", () => {
  it("retire uniquement CR et LF", () => {
    assert.equal(stripCrLf("abc \r\n"), "abc ");
    assert.equal(validateSecret(`${HEX}\r\n`), null);
    assert.equal(validateSecret(`${HEX} `), null);
  });

  it("refuse une valeur trop courte", () => {
    assert.equal(validateSecret("0123456789abcdef"), "secret invalide");
  });

  it("refuse moins de 16 caractères distincts", () => {
    assert.equal(validateSecret("0123456789abcde0123456789abcde01"), "secret invalide");
  });

  it("refuse une sous-chaîne interdite sans tenir compte de la casse", () => {
    assert.equal(validateSecret("0123456789abcdefFLAW0123456789ab"), "secret invalide");
  });

  it("accepte 32 octets hexadécimaux distincts", () => {
    assert.equal(validateSecret(HEX), null);
  });
});

describe("matériau de clé", () => {
  it("refuse un base64 qui ne décode pas 32 octets", () => {
    let encoded = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      encoded = randomBytes(48).toString("base64");
      if (validateSecret(encoded) === null) {
        break;
      }
    }
    assert.equal(validateSecret(encoded), null);
    assert.equal(validateKeyMaterial(encoded), "kek");
  });

  it("accepte un base64 de 32 octets qui passe les règles communes", () => {
    let encoded = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      encoded = randomBytes(32).toString("base64");
      if (validateKeyMaterial(encoded) === null) {
        break;
      }
    }
    assert.equal(validateKeyMaterial(encoded), null);
    assert.equal(Buffer.from(encoded, "base64").length, 32);
  });
});

describe("proxy de confiance", () => {
  const cidr = "172.31.250.10/32";

  it("accepte X-Real-IP depuis l'IP fixe de Caddy", () => {
    assert.equal(resolvedClientIp("172.31.250.10", "203.0.113.9", cidr), "203.0.113.9");
    assert.equal(
      resolvedClientIp("::ffff:172.31.250.10", "198.51.100.8", cidr),
      "198.51.100.8",
    );
  });

  it("ignore X-Real-IP forgé depuis une autre adresse", () => {
    assert.equal(resolvedClientIp("172.31.250.11", "203.0.113.9", cidr), "172.31.250.11");
    assert.equal(resolvedClientIp("172.31.250.10", "pas-une-ip", cidr), "172.31.250.10");
    assert.equal(resolvedClientIp("172.31.250.10", undefined, cidr), "172.31.250.10");
  });
});

describe("lecture des fichiers", () => {
  it("signale un mode lisible par tous", () => {
    assert.equal(worldReadable(0o644), true);
    assert.equal(worldReadable(0o440), false);
    const directory = mkdtempSync(join(tmpdir(), "flaw-healthz-"));
    const file = join(directory, "secret");
    try {
      writeFileSync(file, HEX);
      chmodSync(file, 0o644);
      const result = readSecretFile(file, "secret");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.message, /lisible par tous/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signale EACCES quand le fichier n'est pas lisible", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "flaw-healthz-"));
    const file = join(directory, "secret");
    try {
      writeFileSync(file, HEX);
      chmodSync(file, 0o000);
      const result = readSecretFile(file, "secret");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.message, /EACCES/);
      }
    } finally {
      chmodSync(file, 0o600);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signale un secret absent", () => {
    const result = readSecretFile(join(tmpdir(), "flaw-absent-secret"), "secret");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /secret absent/);
    }
  });
});
