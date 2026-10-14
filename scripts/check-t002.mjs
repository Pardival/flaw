/**
 * T-002 — contrôles AC-090, AC-095, AC-100, AC-102 et exigences SEC du paquet.
 * AC-089 et AC-099 sont hors fichiers de la tâche : ils sont signalés, pas simulés.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function ok(id, detail) {
  console.log(`${id} OK${detail ? ` — ${detail}` : ""}`);
}

function fail(id, detail) {
  console.error(`${id} ÉCHEC — ${detail}`);
  failures.push(`${id}: ${detail}`);
}

function check(id, condition, detail) {
  if (condition) {
    ok(id, detail);
  } else {
    fail(id, detail);
  }
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function docker(args, options = {}) {
  return spawnSync("sudo", ["docker", ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function compose(args, options = {}) {
  return docker(["compose", "-f", "infra/docker-compose.yml", "--project-directory", "infra", ...args], options);
}

function request(url, { rejectUnauthorized = true } = {}) {
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      { rejectUnauthorized, headers: { host: "localhost" } },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: chunks.join(""),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sudoText(args) {
  const result = spawnSync("sudo", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || args.join(" "));
  }
  return result.stdout;
}

function sudoStat(relativePath) {
  const [mode, uid, gid] = sudoText(["stat", "-c", "%a %u %g", join(root, relativePath)]).trim().split(" ");
  return { mode, uid: Number(uid), gid: Number(gid) };
}

function staticChecks() {
  const composeText = read("infra/docker-compose.yml");
  const caddy = read("infra/Caddyfile");
  const dockerfile = read("apps/server/Dockerfile");
  const ignore = read(".dockerignore");
  const init = read("infra/initdb/01-role-applicatif.sh");
  const secretsScript = read("infra/creer-secrets.sh");
  const tracked = [composeText, caddy, dockerfile, init, secretsScript, ignore].join("\n");

  const services = ["caddy", "migrate", "app", "db", "backup", "offsite"];
  for (const service of services) {
    check("A-020", new RegExp(`^  ${service}:`, "m").test(composeText), `service ${service}`);
  }

  const published = [...composeText.matchAll(/^\s+- "(\d+):(\d+)"/gm)].map((match) => match[1]);
  check("SEC-CONT-05", published.length === 2 && published.includes("80") && published.includes("443"), `ports publiés : ${published.join(",")}`);
  check("SEC-CONT-05", !/^\s+- "\d+:5432"/m.test(composeText) && !composeText.includes("/var/run/docker.sock"), "base non publiée, pas de socket Docker");
  check("SEC-DB-01", !/adminer|pgadmin|phpmyadmin/i.test(composeText), "pas d'outil d'admin web");

  const capDrops = composeText.match(/cap_drop:/g) ?? [];
  const readOnly = composeText.match(/read_only: true/g) ?? [];
  const noNew = composeText.match(/no-new-privileges:true/g) ?? [];
  check("SEC-CONT-04", capDrops.length === services.length && noNew.length === services.length, "cap_drop ALL et no-new-privileges sur chaque service");
  check("SEC-CONT-02", readOnly.length === services.length, "racine en lecture seule");
  check("SEC-CONT-02", /user: "10001:10001"/.test(composeText) && /user: "70:70"/.test(composeText) && /user: "10003:10003"/.test(composeText), "UID 10001, 70, 10003");
  check("A-020", /ipv4_address: 172\.30\.20\.2/.test(composeText) && /internal: true/.test(composeText), "Caddy IP fixe sur edge, backend interne");
  check("A-020", /1536m/.test(composeText) && /1536M/.test(composeText), "mémoire applicative 1,5 Go");
  check("SEC-CONT-01", (composeText.match(/@sha256:/g) ?? []).length >= 4 && !/:latest/.test(composeText), "images épinglées par empreinte");
  check("A-003", composeText.includes("postgres:18.6-alpine@sha256:"), "PostgreSQL 18.6 alpine");
  check("SEC-SECRET-07", !/POSTGRES_PASSWORD(?!_FILE)/.test(composeText) && composeText.includes("refus de démarrer"), "pas de mot de passe en variable, refus sans secret");
  check("SEC-SECRET-05", !/POSTGRES_PASSWORD\s*:/.test(composeText), "aucun mot de passe PostgreSQL inline");
  check("AC-090", composeText.includes("pg_dump") && composeText.includes("sleep 21600"), "pg_dump toutes les 6 h");
  check("AC-100", composeText.includes("--keep-daily 7") && composeText.includes("--keep-weekly 4") && composeText.includes("--keep-monthly 12"), "rétention restic 7/4/12");
  check("SEC-DB-02", init.includes("flaw_app") && init.includes("NOSUPERUSER") && init.includes("NOCREATEDB") && init.includes("NOCREATEROLE"), "rôle flaw_app à moindre privilège");

  check("SEC-WEB-01", caddy.includes("protocols tls1.2 tls1.3") && !caddy.includes("tls1.0") && !caddy.includes("tls1.1"), "TLS 1.2+");
  check("SEC-WEB-02", caddy.includes("Strict-Transport-Security"), "HSTS");
  check("SEC-WEB-03", caddy.includes("Content-Security-Policy") && caddy.includes("default-src 'none'") && !caddy.includes("unsafe-inline") && !caddy.includes("unsafe-eval"), "CSP stricte");
  check("SEC-WEB-04", ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"].every((header) => caddy.includes(header)), "en-têtes complémentaires");
  check("A-020", caddy.includes("{$FLAW_DOMAIN}") && caddy.includes("reverse_proxy app:3000"), "seul FLAW_DOMAIN, proxy vers l'app");
  check("API-023", dockerfile.includes("/api/v1/healthz") && dockerfile.includes("refus de démarrer"), "sonde et refus sans secret");
  check("SEC-CONT-01", dockerfile.split("\n").filter((line) => line.startsWith("FROM ")).length === 2, "Dockerfile multi-étapes");
  check("SEC-CONT-02", dockerfile.includes("USER 10001:10001"), "image applicative non-root");
  check("SEC-CONT-09", ["**/.env", "infra/secrets", "**/node_modules", ".git"].every((entry) => ignore.includes(entry)), ".dockerignore");

  const trackers = ["google-analytics", "googletagmanager", "doubleclick", "segment.io", "mixpanel", "hotjar", "plausible", "amplitude.com", "sentry.io"];
  check("AC-102", trackers.every((host) => !tracked.includes(host)), "aucun hôte d'analytique dans les fichiers d'infra");
  check("SEC-SECRET-06", secretsScript.includes("chmod 600") && secretsScript.includes("FLAW_DOMAIN"), ".env 600 et FLAW_DOMAIN");

  console.log("AC-089 HORS PÉRIMÈTRE — réglage « Correcteur du navigateur » absent des fichiers T-002");
  console.log("AC-099 HORS PÉRIMÈTRE — export ZIP absent des fichiers T-002");
}

async function waitFor(label, predicate, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) {
      return true;
    }
    await sleep(2000);
  }
  fail(label, "délai dépassé");
  return false;
}

function showLogs() {
  const logs = compose(["logs", "--no-color", "--tail", "80"]);
  console.error(logs.stdout);
  console.error(logs.stderr);
}

async function integration() {
  const info = docker(["info"]);
  check("AC-095", info.status === 0, "docker disponible");
  if (info.status !== 0) {
    return;
  }

  const missingDomain = spawnSync("sudo", ["-E", "infra/creer-secrets.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FLAW_DOMAIN: "" },
  });
  check("SEC-SECRET-07", missingDomain.status !== 0, "creer-secrets.sh refuse un domaine vide");

  const created = spawnSync("sudo", ["-E", "infra/creer-secrets.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FLAW_DOMAIN: "localhost" },
  });
  if (created.status !== 0) {
    fail("SEC-SECRET-06", created.stderr || created.stdout || "creer-secrets.sh a échoué");
    return;
  }
  const secret = sudoText(["cat", join(root, "infra/secrets/db_app_password")]);
  const appSecret = sudoStat("infra/secrets/db_app_password");
  const dbSecret = sudoStat("infra/secrets/db_superuser_password");
  const resticSecret = sudoStat("infra/secrets/restic_password");
  check("SEC-SECRET-06", !created.stdout.includes(secret) && !created.stderr.includes(secret), "les valeurs ne sont pas affichées");
  check("SEC-SECRET-06", (statSync(join(root, "infra/.env")).mode & 0o777) === 0o600, ".env en 600");
  check("SEC-SECRET-06", dbSecret.mode === "400", "secret base en 400");
  check("SEC-SECRET-06", appSecret.mode === "440", "secret applicatif en 440");
  check("SEC-SECRET-06", resticSecret.mode === "400", "secret restic en 400");
  check("A-020", appSecret.uid === 10001, "propriétaire du secret applicatif = UID 10001");
  check("A-020", dbSecret.uid === 70, "propriétaire du secret base = UID 70");

  const envBackup = read("infra/.env");
  const hiddenEnv = join(tmpdir(), "flaw-env-hidden");
  spawnSync("sudo", ["mv", join(root, "infra/.env"), hiddenEnv]);
  const withoutDomain = compose(["config"], {
    env: { ...process.env, FLAW_DOMAIN: "" },
  });
  spawnSync("sudo", ["mv", hiddenEnv, join(root, "infra/.env")]);
  check("SEC-SECRET-07", withoutDomain.status !== 0, "compose refuse de démarrer sans FLAW_DOMAIN");
  if (!read("infra/.env").includes("FLAW_DOMAIN=")) {
    writeFileSync(join(root, "infra/.env"), envBackup, { mode: 0o600 });
  }

  const configured = compose(["config"]);
  check("AC-095", configured.status === 0, "docker compose config");
  if (configured.status !== 0) {
    console.error(configured.stderr);
    return;
  }

  compose(["down", "-v", "--remove-orphans"], { timeout: 120000 });
  const up = compose(["up", "-d", "--build"], { timeout: 420000 });
  if (up.status !== 0) {
    fail("AC-095", up.stderr || up.stdout || "docker compose up a échoué");
    showLogs();
    return;
  }

  const healthy = await waitFor("AC-095", async () => {
    try {
      const response = await request("https://localhost/api/v1/healthz", { rejectUnauthorized: false });
      return response.status === 200 && response.body.includes('"status":"ok"');
    } catch {
      return false;
    }
  }, 40);
  if (!healthy) {
    showLogs();
    return;
  }
  ok("AC-095", "docker compose up sert /api/v1/healthz");
  ok("API-023", "GET /api/v1/healthz → 200 sans authentification");

  const secure = await request("https://localhost/api/v1/healthz", { rejectUnauthorized: false });
  const headers = secure.headers;
  check("SEC-WEB-01", secure.status === 200, "réponse HTTPS");
  check("SEC-WEB-02", String(headers["strict-transport-security"] ?? "").includes("max-age="), "HSTS reçu");
  check("SEC-WEB-03", String(headers["content-security-policy"] ?? "").includes("default-src 'none'"), "CSP reçue");
  check("SEC-WEB-04", headers["x-content-type-options"] === "nosniff" && headers["x-frame-options"] === "DENY" && headers["referrer-policy"] === "no-referrer", "en-têtes reçus");

  const redirected = await request("http://localhost/api/v1/healthz");
  const location = String(redirected.headers.location ?? "");
  check("SEC-WEB-01", redirected.status >= 300 && redirected.status < 400 && location.startsWith("https://"), `redirection HTTP ${redirected.status} ${location}`);

  const ids = compose(["ps", "-aq"]);
  const containerIds = ids.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const inspected = containerIds.map((id) => JSON.parse(docker(["inspect", id]).stdout)[0]);
  const byName = (service) => inspected.find((item) => item.Config.Labels?.["com.docker.compose.service"] === service);

  for (const service of ["caddy", "db", "app", "backup", "offsite", "migrate"]) {
    const item = byName(service);
    if (!item) {
      fail("SEC-CONT-04", `conteneur ${service} introuvable`);
      continue;
    }
    const capDrop = item.HostConfig.CapDrop ?? [];
    const bindings = Object.keys(item.HostConfig.PortBindings ?? {});
    check("SEC-CONT-04", capDrop.includes("ALL") && (item.HostConfig.SecurityOpt ?? []).some((entry) => entry.includes("no-new-privileges")), `${service} capabilities`);
    check("SEC-CONT-02", item.HostConfig.ReadonlyRootfs === true, `${service} lecture seule`);
    if (service !== "caddy") {
      check("SEC-CONT-05", bindings.length === 0, `${service} sans port publié`);
    }
  }

  const caddy = byName("caddy");
  const caddyBindings = caddy?.HostConfig.PortBindings ?? {};
  const caddyHostPorts = Object.values(caddyBindings)
    .flat()
    .map((binding) => binding?.HostPort)
    .filter(Boolean);
  check("SEC-CONT-05", Object.keys(caddyBindings).length === 2 && caddyHostPorts.includes("80") && caddyHostPorts.includes("443"), `ports hôte caddy ${caddyHostPorts.join(",")}`);
  check("SEC-CONT-02", caddy?.Config.User === "" || caddy?.Config.User === "root" || caddy?.Config.User === "0", "Caddy root, exception A-020");

  const app = byName("app");
  check("SEC-CONT-02", app?.Config.User === "10001:10001", "app UID 10001");
  check("A-020", app?.HostConfig.Memory === 1536 * 1024 * 1024, `mémoire ${app?.HostConfig.Memory ?? 0}`);
  const appBinds = (app?.HostConfig.Binds ?? []).join(" ");
  check("SEC-SECRET-05", appBinds.includes("db_app_password") && !appBinds.includes("db_superuser_password") && !appBinds.includes("restic_"), "l'app ne reçoit que son secret");

  const db = byName("db");
  check("SEC-CONT-02", db?.Config.User === "70:70", "db UID 70");
  const dbBinds = (db?.HostConfig.Binds ?? []).join(" ");
  check("SEC-DB-01", !dbBinds.includes("restic_") && (db?.HostConfig.PortBindings ?? null) === null || Object.keys(db?.HostConfig.PortBindings ?? {}).length === 0, "base sans port publié");

  const role = compose(["exec", "-T", "db", "psql", "-U", "postgres", "-d", "flaw", "-tA", "-c", "SELECT rolname || ':' || rolsuper::text || ':' || rolcreatedb::text || ':' || rolcreaterole::text FROM pg_roles WHERE rolname = 'flaw_app'"]);
  check("SEC-DB-02", role.stdout.trim() === "flaw_app:false:false:false", role.stdout.trim() || role.stderr);

  const dumped = await waitFor("AC-090", async () => {
    const listing = spawnSync("sudo", ["find", join(root, "infra/run/backups"), "-type", "f", "-name", "flaw-*.dump", "-size", "+0"], { encoding: "utf8" });
    return listing.status === 0 && listing.stdout.trim().length > 0;
  }, 30);
  if (dumped) {
    const dumpPath = sudoText(["find", join(root, "infra/run/backups"), "-type", "f", "-name", "flaw-*.dump", "-size", "+0"]).trim().split("\n").at(-1);
    const dumpName = dumpPath.slice(dumpPath.lastIndexOf("/") + 1);
    const listed = compose(["exec", "-T", "backup", "pg_restore", "-l", `/var/lib/flaw/backups/${dumpName}`]);
    check("AC-090", listed.status === 0 && listed.stdout.length > 0, listed.stderr.trim() || "dump pg_restore lisible");
  }

  const snapped = await waitFor("AC-100", async () => {
    const snapshots = compose([
      "exec",
      "-T",
      "offsite",
      "/bin/sh",
      "-c",
      "export HOME=/tmp RESTIC_PASSWORD_FILE=/run/secrets/restic_password RESTIC_REPOSITORY=$(tr -d '\\n' < /run/secrets/restic_repository); restic snapshots --no-lock",
    ]);
    return snapshots.status === 0 && snapshots.stdout.includes("/backups");
  }, 30);
  if (snapped) {
    ok("AC-100", "snapshot restic du dump (rétention 7/4/12 dans la commande)");
  }

  const leaked = docker([
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    "-v",
    `${join(root, "infra/secrets/db_app_password")}:/tmp/secret:ro`,
    "flaw-app:t002",
    "-c",
    "grep -R -F \"$(cat /tmp/secret)\" /app >/dev/null 2>&1 && exit 1 || exit 0",
  ]);
  check("SEC-SECRET-05", leaked.status === 0, "secret applicatif absent de l'image");

  const emptyDir = join(tmpdir(), "flaw-empty-secret");
  spawnSync("sudo", ["mkdir", "-p", emptyDir]);
  const emptyFile = join(emptyDir, "empty");
  spawnSync("sudo", ["sh", "-c", `printf '' > ${emptyFile} && chown 10001:10001 ${emptyFile} && chmod 400 ${emptyFile}`]);
  const refused = docker([
    "run",
    "--rm",
    "--user",
    "10001:10001",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${emptyFile}:/run/secrets/db_app_password:ro`,
    "flaw-app:t002",
  ]);
  check("SEC-SECRET-07", refused.status !== 0 && refused.stderr.includes("refus de démarrer"), "l'app refuse un secret vide");

  const worldFile = join(emptyDir, "world");
  spawnSync("sudo", ["sh", "-c", `printf '%s' '${secret}' > ${worldFile} && chown 10001:10001 ${worldFile} && chmod 644 ${worldFile}`]);
  const world = docker([
    "run",
    "--rm",
    "--user",
    "10001:10001",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${worldFile}:/run/secrets/db_app_password:ro`,
    "flaw-app:t002",
  ]);
  check("SEC-SECRET-07", world.status !== 0, "l'app refuse un secret lisible par tous");
  spawnSync("sudo", ["rm", "-rf", emptyDir]);
}

staticChecks();
try {
  await integration();
} finally {
  compose(["down", "-v", "--remove-orphans"], { timeout: 120000 });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} contrôle(s) en échec.`);
  process.exit(1);
}
console.log("\nT-002 : contrôles exécutés sans échec.");
