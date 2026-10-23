import { describe, expect, it } from "vitest";

import { messages } from "./messages.fr.ts";
import {
  BACKUP_FILENAME,
  RECOVERY_CODE_COUNT,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD,
  backupText,
  formatRecoveryCode,
  formatSecret,
  formatTotp,
  groupSecret,
  otpauthUri,
} from "./policy.ts";

const secret = "A".repeat(32);

describe("formats TOTP et codes de secours", () => {
  it("accepte 6 chiffres et refuse le reste", () => {
    expect(formatTotp(" 123 456 ")).toBe("123456");
    expect(formatTotp("12345")).toBeNull();
    expect(formatTotp("1234567")).toBeNull();
    expect(formatTotp("12345a")).toBeNull();
  });

  it("groupe 16 caractères base32 en XXXX-XXXX-XXXX-XXXX", () => {
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(formatRecoveryCode(" aaaa-aaaa-aaaa-aaaa ")).toBe("AAAA-AAAA-AAAA-AAAA");
    expect(formatRecoveryCode("AAAAAAAAAAAAAAAA")).toBe("AAAA-AAAA-AAAA-AAAA");
    expect(formatRecoveryCode("AAAA-AAAA-AAAA-AAA0")).toBeNull();
    expect(formatRecoveryCode("AAAA-AAAA-AAAA-AAA1")).toBeNull();
    expect(formatRecoveryCode("AAAA-AAAA-AAAA-AAA8")).toBeNull();
    expect(formatRecoveryCode("AAAA-AAAA-AAAA-AAA")).toBeNull();
  });

  it("affiche la clé par groupes de 4", () => {
    expect(formatSecret(` ${secret.toLowerCase()} `)).toBe(secret);
    expect(formatSecret("0000000000000000")).toBeNull();
    expect(groupSecret(secret)).toBe("AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA");
  });

  it("écrit un fichier texte, une ligne par code", () => {
    expect(BACKUP_FILENAME).toBe("codes-secours.txt");
    expect(backupText(["AAAA-AAAA-AAAA-AAAA"])).toBe("AAAA-AAAA-AAAA-AAAA\n");
  });
});

describe("lien otpauth", () => {
  it("décrit le TOTP du serveur sans adresse http", () => {
    expect(TOTP_ALGORITHM).toBe("SHA1");
    expect(TOTP_DIGITS).toBe("6");
    expect(TOTP_PERIOD).toBe("30");
    expect(otpauthUri(secret, "ada@exemple.fr", messages.issuer)).toBe(
      "otpauth://totp/Flaw%3Aada%40exemple.fr?secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&issuer=Flaw&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("reste sur le schéma otpauth même si le libellé est hostile", () => {
    const uri = otpauthUri(secret, "javascript:alert(1)", messages.issuer);
    expect(uri?.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).not.toMatch(/^javascript:/);
    expect(uri).not.toMatch(/https?:\/\//);
    expect(otpauthUri("0000000000000000", "ada@exemple.fr", messages.issuer)).toBeNull();
  });
});
