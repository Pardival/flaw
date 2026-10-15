import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  readSecretFile,
  resolvedClientIp,
  stripFinalNewline,
  validateKeyMaterial,
  validateSecret,
  worldReadable,
} from "./healthz.ts";

const HEX = "0123456789abcdef0123456789abcdef";

describe("validateur de secrets", () => {
  it("retire uniquement le saut de ligne final", () => {
    assert.equal(stripFinalNewline("abc \r\n"), "abc ");
    assert.equal(stripFinalNewline(`${HEX}\r\n`), HEX);
    assert.equal(stripFinalNewline(`${HEX}\n`), HEX);
    assert.equal(validateSecret(`${HEX}\r\n`), null);
    assert.equal(validateSecret(`${HEX}\n`), null);
    assert.equal(validateSecret(`${HEX} `), null);
  });

  it("ne modifie pas une valeur suivie d'un espace", () => {
    const withSpace = `${HEX} `;
    assert.equal(stripFinalNewline(withSpace), withSpace);
    assert.equal(Buffer.byteLength(withSpace, "utf8"), 33);
    assert.equal(validateSecret(withSpace), null);

    const fifteen = "0123456789abcde0123456789abcde01";
    const spaceCounts = "0123456789abcde0123456789abcde0 ";
    assert.equal(fifteen.length, 32);
    assert.equal(spaceCounts.length, 32);
    assert.equal(validateSecret(fifteen), "secret invalide");
    assert.equal(validateSecret(spaceCounts), null);
    assert.equal(stripFinalNewline(spaceCounts), spaceCounts);

    const directory = mkdtempSync(join(tmpdir(), "flaw-healthz-"));
    const file = join(directory, "secret");
    try {
      writeFileSync(file, withSpace);
      chmodSync(file, 0o600);
      const result = readSecretFile(file, "secret");
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value, withSpace);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuse 31 octets", () => {
    const value = "0123456789abcdef0123456789abcde";
    assert.equal(Buffer.byteLength(value, "utf8"), 31);
    assert.equal(validateSecret(value), "secret invalide");
  });

  it("refuse une valeur trop courte", () => {
    assert.equal(validateSecret("0123456789abcdef"), "secret invalide");
  });

  it("refuse moins de 16 caractères distincts", () => {
    assert.equal(validateSecret("0123456789abcde0123456789abcde01"), "secret invalide");
  });

  it("refuse une sous-chaîne interdite sans tenir compte de la casse", () => {
    assert.equal(validateSecret("0123456789abcdefFLAW0123456789ab"), "secret invalide");
    assert.equal(validateSecret("0123456789abcdefAdmin0123456789ab"), "secret invalide");
    assert.equal(validateSecret("0123456789abcdefTEST0123456789abcd"), "secret invalide");
  });

  it("refuse un CR ou un LF qui n'est pas le saut de ligne final", () => {
    const embeddedNl = `${HEX.slice(0, 16)}\n${HEX.slice(16)}`;
    const embeddedCr = `${HEX.slice(0, 16)}\r${HEX.slice(16)}`;
    assert.equal(stripFinalNewline(embeddedNl), embeddedNl);
    assert.equal(stripFinalNewline(embeddedCr), embeddedCr);
    assert.equal(validateSecret(embeddedNl), "secret invalide");
    assert.equal(validateSecret(embeddedCr), "secret invalide");
    assert.equal(stripFinalNewline(`${HEX}\n\n`), `${HEX}\n`);
    assert.equal(stripFinalNewline(`${HEX}\r\n\n`), `${HEX}\r\n`);
    assert.equal(validateSecret(`${HEX}\n\n`), "secret invalide");
    assert.equal(validateSecret(`${HEX}\r\n\n`), "secret invalide");
    assert.equal(validateSecret(`${HEX}\r\n\r\n`), "secret invalide");
    assert.equal(validateSecret(`${HEX}\r`), "secret invalide");
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

describe("parité initdb, creer-secrets.sh et healthz.ts", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const creerSecrets = readFileSync(join(root, "infra/creer-secrets.sh"), "utf8");
  const initdb = readFileSync(join(root, "infra/initdb/01-role-applicatif.sh"), "utf8");
  // Q-007 : l'awk qui valide en production est celui de l'image postgres épinglée
  // (busybox), pas celui de l'hôte CI. LC_ALL=C ne fige que la largeur des
  // caractères de gawk ; mawk, nawk et busybox divergent encore. Le digest
  // fige le binaire (SEC-CONT-01), le même que docker-compose.yml.
  const postgresImage =
    "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
  const awkContainer = `flaw-secret-awk-${process.pid}`;

  before(() => {
    const started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        awkContainer,
        "--network",
        "none",
        "--entrypoint",
        "sleep",
        "-v",
        `${root}:/work:ro`,
        postgresImage,
        "300",
      ],
      { encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    const ready = spawnSync("docker", ["exec", awkContainer, "true"], { encoding: "utf8" });
    assert.equal(ready.status, 0, ready.stderr);
  });

  after(() => {
    spawnSync("docker", ["rm", "-f", awkContainer], { encoding: "utf8" });
  });

  const preludes = {
    "creer-secrets.sh": [
      '_here=$(CDPATH= cd -- "$(dirname "$ROOT/infra/creer-secrets.sh")" && pwd)',
      '. "$_here/initdb/secret-valide.inc"',
    ].join("\n"),
    "initdb": [
      '_here=$(CDPATH= cd -- "$(dirname "$ROOT/infra/initdb/01-role-applicatif.sh")" && pwd)',
      '. "$_here/secret-valide.inc"',
    ].join("\n"),
  };

  function shellVerdict(prelude: string, raw: string): { ok: boolean; normalised: Buffer } {
    const script = [
      prelude,
      'if secret_valide "$SECRET"; then code=0; else code=1; fi',
      "printf '%s\\n' \"$code\"",
      'norm=$(secret_normalise "$SECRET"; printf x)',
      "printf '%s' \"${norm%x}\"",
    ].join("\n");
    const result = spawnSync(
      "docker",
      ["exec", "-e", `SECRET=${raw}`, "-e", "ROOT=/work", awkContainer, "sh", "-c", script],
    );
    assert.equal(result.status, 0, result.stderr.toString("utf8"));
    const stdout = result.stdout;
    const split = stdout.indexOf(0x0a);
    assert.ok(split >= 0);
    return { ok: stdout.subarray(0, split).toString("utf8") === "0", normalised: stdout.subarray(split + 1) };
  }

  it("source le même validateur et ne retire plus tous les CR/LF", () => {
    assert.match(creerSecrets, /initdb\/secret-valide\.inc/);
    assert.match(initdb, /secret-valide\.inc/);
    assert.match(initdb, /secret_normalise/);
    assert.equal(creerSecrets.includes("tr -d '\\r\\n'"), false);
    assert.equal(initdb.includes("tr -d '\\r\\n'"), false);
  });

  const cases: Array<{ name: string; raw: string }> = [
    { name: "espace final conservé", raw: `${HEX} ` },
    { name: "espace final compté", raw: "0123456789abcde0123456789abcde0 " },
    { name: "\\r\\n final retiré", raw: `${HEX}\r\n` },
    { name: "\\n final retiré", raw: `${HEX}\n` },
    { name: "\\n\\n refusé", raw: `${HEX}\n\n` },
    { name: "\\r\\n\\n refusé", raw: `${HEX}\r\n\n` },
    { name: "espace puis \\r\\n", raw: `${HEX} \r\n` },
    { name: "CR interne refusé", raw: `${HEX.slice(0, 16)}\r${HEX.slice(16)}` },
    { name: "LF interne refusé", raw: `${HEX.slice(0, 16)}\n${HEX.slice(16)}` },
    { name: "31 octets", raw: "0123456789abcdef0123456789abcde" },
    { name: "Admin", raw: "0123456789abcdefAdmin0123456789ab" },
    { name: "TEST", raw: "0123456789abcdefTEST0123456789abcd" },
    { name: "octets UTF-8 acceptés", raw: `0123456789abcdef${"é".repeat(16)}` },
    { name: "longueur en octets UTF-8", raw: "0123456789abcde0123456789abcdeé" },
  ];

  for (const [origin, prelude] of Object.entries(preludes)) {
    for (const sample of cases) {
      it(`${origin} : ${sample.name}`, () => {
        const expected = stripFinalNewline(sample.raw);
        const shell = shellVerdict(prelude, sample.raw);
        assert.equal(shell.ok, validateSecret(sample.raw) === null);
        assert.deepEqual(shell.normalised, Buffer.from(expected, "utf8"));
      });
    }
  }

  function hostGawkAccepts(validatorSource: string, raw: string): boolean {
    const directory = mkdtempSync(join(tmpdir(), "flaw-gawk-"));
    try {
      mkdirSync(join(directory, "bin"));
      writeFileSync(join(directory, "secret-valide.inc"), validatorSource);
      writeFileSync(join(directory, "bin/awk"), "#!/bin/sh\nexec gawk \"$@\"\n");
      chmodSync(join(directory, "bin/awk"), 0o755);
      const result = spawnSync(
        "sh",
        ["-c", '. ./secret-valide.inc; if secret_valide "$SECRET"; then echo 0; else echo 1; fi'],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
            LC_ALL: "C.UTF-8",
            SECRET: raw,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim() === "0";
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function skipWithoutGawk(t: { skip: (message?: string) => void }): boolean {
    const gawk = spawnSync("gawk", ["--version"], { encoding: "utf8" });
    if (gawk.status === 0) {
      return false;
    }
    if (process.env.CI) {
      assert.fail("gawk absent en CI : le cas doit s'exécuter");
    }
    t.skip("gawk absent : cas sauté. La CI installe gawk pour l'exécuter.");
    return true;
  }

  const gawkCases: Array<{ name: string; raw: string }> = [
    { name: "\\n\\n refusé", raw: `${HEX}\n\n` },
    { name: "\\r\\n\\n refusé", raw: `${HEX}\r\n\n` },
  ];

  for (const sample of gawkCases) {
    it(`gawk hôte : ${sample.name}`, (t) => {
      if (skipWithoutGawk(t)) {
        return;
      }
      const validator = readFileSync(join(root, "infra/initdb/secret-valide.inc"), "utf8");
      assert.equal(validateSecret(sample.raw), "secret invalide");
      assert.equal(hostGawkAccepts(validator, sample.raw), false);
    });
  }

  it("gawk hôte : creer-secrets.sh détecte une mutation LC_ALL=C", (t) => {
    if (skipWithoutGawk(t)) {
      return;
    }
    const probe = `0123456789abcdef${"é".repeat(8)}`;
    assert.equal(Buffer.byteLength(probe, "utf8"), 32);
    assert.equal([...probe].length, 24);
    assert.equal(validateSecret(probe), null);
    const validatorPath = join(root, "infra/initdb/secret-valide.inc");
    const validator = readFileSync(validatorPath, "utf8");
    assert.match(creerSecrets, /initdb\/secret-valide\.inc/);
    assert.match(validator, /LC_ALL=C awk/);
    assert.equal(hostGawkAccepts(validator, probe), true);
    const mutated = validator.replaceAll("LC_ALL=C awk", "awk");
    assert.notEqual(mutated, validator);
    assert.equal(hostGawkAccepts(mutated, probe), false);
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

describe("refus de démarrer si un poivre égale la KEK", () => {
  function cleValide(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const encoded = randomBytes(32).toString("base64");
      if (validateKeyMaterial(encoded) === null) {
        return encoded;
      }
    }
    throw new Error("aucune cle de test");
  }

  it("quitte si hmac_pepper égale la KEK", () => {
    const source = readFileSync(fileURLToPath(new URL("./healthz.ts", import.meta.url)), "utf8");
    assert.match(source, /peppersMatchKek\(kek, hmacPepper, recoveryPepper\)/);
    assert.match(source, /refuse\("refus de démarrer : poivre"\)/);

    const kek = cleValide();
    const recovery = cleValide();
    const directory = mkdtempSync(join(tmpdir(), "flaw-healthz-poivre-"));
    const file = (name: string, contents: string) => {
      const path = join(directory, name);
      writeFileSync(path, contents);
      chmodSync(path, 0o600);
      return path;
    };
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./healthz.ts", import.meta.url))], {
        encoding: "utf8",
        timeout: 8_000,
        env: {
          PATH: process.env.PATH ?? "",
          PORT: "0",
          DATABASE_PASSWORD_FILE: file("app_db_password", HEX),
          BETTER_AUTH_SECRET_FILE: file("better_auth_secret", HEX),
          FLAW_KEK_FILE: file("flaw_kek", kek),
          HMAC_PEPPER_FILE: file("hmac_pepper", kek),
          RECOVERY_PEPPER_FILE: file("recovery_pepper", recovery),
        },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr ?? "", /refus de démarrer : poivre/);
      assert.doesNotMatch(`${result.stdout ?? ""}${result.stderr ?? ""}`, new RegExp(kek.replace(/[+/]/g, "\\$&")));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
