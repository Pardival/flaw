import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, secretsAreLoaded } from "./load.ts";
import { loadSecrets } from "./secrets.ts";
import { readSecretFile, validateKeyMaterial } from "../platform/healthz.ts";

const HEX = "0123456789abcdef0123456789abcdef";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const directories: string[] = [];

function validKey(): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const encoded = randomBytes(32).toString("base64");
    if (validateKeyMaterial(`${encoded}\r\n`) === null) {
      return encoded;
    }
  }
  throw new Error("aucune clé de test");
}

function writeSecrets(values: {
  databasePassword: string;
  betterAuthSecret: string;
  kek: string;
  recoveryPepper: string;
  hmacPepper: string;
}, mode = 0o600): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "flaw-config-"));
  directories.push(directory);
  const files = {
    DATABASE_PASSWORD_FILE: join(directory, "app_db_password"),
    BETTER_AUTH_SECRET_FILE: join(directory, "better_auth_secret"),
    FLAW_KEK_FILE: join(directory, "flaw_kek"),
    RECOVERY_PEPPER_FILE: join(directory, "recovery_pepper"),
    HMAC_PEPPER_FILE: join(directory, "hmac_pepper"),
  };
  writeFileSync(files.DATABASE_PASSWORD_FILE, values.databasePassword);
  writeFileSync(files.BETTER_AUTH_SECRET_FILE, values.betterAuthSecret);
  writeFileSync(files.FLAW_KEK_FILE, values.kek);
  writeFileSync(files.RECOVERY_PEPPER_FILE, values.recoveryPepper);
  writeFileSync(files.HMAC_PEPPER_FILE, values.hmacPepper);
  for (const file of Object.values(files)) {
    chmodSync(file, mode);
  }
  return { ...files, NODE_ENV: "test" };
}

function validSet(overrides: Partial<{
  databasePassword: string;
  betterAuthSecret: string;
  kek: string;
  recoveryPepper: string;
  hmacPepper: string;
}> = {}) {
  return {
    databasePassword: HEX,
    betterAuthSecret: HEX,
    kek: validKey(),
    recoveryPepper: validKey(),
    hmacPepper: validKey(),
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SEC-SECRET-07 via le validateur T-002", () => {
  it("n'embarque pas une seconde liste de mots interdits", () => {
    const source = [
      "env.ts",
      "secrets.ts",
      "load.ts",
      "../app.ts",
    ]
      .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"))
      .join("\n");
    expect(source).toContain("readSecretFile");
    expect(source).not.toContain("motdepasse");
    expect(source).not.toContain("stripCrLf");
  });

  it("refuse .env.example copié tel quel", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).not.toMatch(/^[A-Z0-9_]+=/m);
    const result = spawnSync(process.execPath, ["apps/server/src/app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refus de démarrer/);
    expect(result.stderr).toMatch(/secret absent/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/0123456789abcdef/);
  });

  it("refuse 31 octets, peu de caractères distincts, Admin, TEST et un mode 644", () => {
    const tooShort = "0123456789abcdef";
    const fewDistinct = "0123456789abcde0123456789abcde01";
    const hasAdmin = "0123456789abcdefAdmin0123456789ab";
    const hasTest = "0123456789abcdefTEST0123456789abcd";
    const marker = "0123456789abcdefflaw0123456789";
    const cases = [
      { databasePassword: tooShort, message: /secret invalide/ },
      { databasePassword: fewDistinct, message: /secret invalide/ },
      { databasePassword: hasAdmin, message: /secret invalide/ },
      { databasePassword: hasTest, message: /secret invalide/ },
      { databasePassword: marker, message: /secret invalide/ },
    ];
    for (const item of cases) {
      const env = writeSecrets(validSet({ databasePassword: item.databasePassword }));
      const result = loadSecrets(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(item.message);
        expect(result.message).not.toContain(item.databasePassword);
      }
    }
    const readable = writeSecrets(validSet(), 0o644);
    const refused = loadSecrets(readable);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toMatch(/lisible par tous/);
    }
  });

  it("accepte une clé openssl suivie de CRLF et laisse l'espace au validateur commun", () => {
    const env = writeSecrets(validSet({
      databasePassword: `${HEX}\r\n`,
      betterAuthSecret: `${HEX} `,
      kek: `${validKey()}\r\n`,
      recoveryPepper: `${validKey()}\n`,
      hmacPepper: `${validKey()}\n`,
    }));
    const direct = readSecretFile(env.BETTER_AUTH_SECRET_FILE ?? "", "secret");
    const loaded = loadSecrets(env);
    expect(loaded.ok).toBe(direct.ok);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && direct.ok) {
      expect(loaded.secrets.betterAuthSecret).toBe(direct.value);
      expect(loaded.secrets.databasePassword).toBe(HEX);
    }
  });

  it("refuse un poivre égal à la KEK", () => {
    const kek = validKey();
    const env = writeSecrets(validSet({ kek, hmacPepper: kek }));
    const result = loadSecrets(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("refus de démarrer : poivre");
      expect(result.message).not.toContain(kek);
    }
  });

  it("refuse hmac_pepper égal à recovery_pepper", () => {
    const pepper = validKey();
    const env = writeSecrets(validSet({ hmacPepper: pepper, recoveryPepper: pepper }));
    const result = loadSecrets(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("refus de démarrer : poivre");
      expect(result.message).not.toContain(pepper);
    }
  });

  it("signale un fichier absent sans démarrer", () => {
    const result = loadConfig({ NODE_ENV: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/secret absent/);
    }
    expect(secretsAreLoaded()).toBe(false);
  });
});

describe("configuration", () => {
  it("refuse un journal de débogage en production", () => {
    const result = loadConfig({ NODE_ENV: "production", LOG_LEVEL: "debug" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("refus de démarrer : journal de débogage interdit");
    }
    const trace = loadConfig({ NODE_ENV: "production", LOG_LEVEL: "trace" });
    expect(trace.ok).toBe(false);
  });

  it("refuse un port illisible, un mot de passe trop court et un corps au-dessus de 10 Mo", () => {
    expect(loadConfig({ PORT: "no" }).ok).toBe(false);
    expect(loadConfig({ PASSWORD_MIN_LENGTH: "7" }).ok).toBe(false);
    expect(loadConfig({ MAX_DOCUMENT_SIZE_MB: "11" }).ok).toBe(false);
    expect(loadConfig({ MAX_DOCUMENT_SIZE_MB: "5", MAX_WS_MESSAGE_MB: "10" }).ok).toBe(false);
    const invalid = loadConfig({ PORT: "no" });
    if (!invalid.ok) {
      expect(invalid.message).toBe("refus de démarrer : configuration invalide");
    }
  });

  it("charge les défauts du modèle et un corps de 10 Mio", () => {
    const env = writeSecrets(validSet());
    const loaded = loadConfig({ ...env, NODE_ENV: "production", LOG_LEVEL: "info" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.bodyLimit).toBe(10 * 1024 * 1024);
      expect(loaded.config.PASSWORD_MIN_LENGTH).toBe(15);
      expect(loaded.config.allowSignup).toBe(false);
      expect(loaded.config.FLAW_AUTH_BEARER_ENABLED).toBe("false");
      expect(loaded.config.bearerEnabled).toBe(false);
      expect(loaded.config.logLevel).toBe("info");
      expect(JSON.stringify(loaded.config)).not.toContain(HEX);
    }
    const enabled = loadConfig({ ...env, NODE_ENV: "production", LOG_LEVEL: "info", FLAW_AUTH_BEARER_ENABLED: "true" });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) {
      expect(enabled.config.bearerEnabled).toBe(true);
    }
  });
});
