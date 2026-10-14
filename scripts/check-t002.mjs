/**
 * Contrôles T-002 : statique, tests de healthz, puis pile isolée si uid 0.
 * Projet Compose dédié. Ne supprime jamais les volumes du projet par défaut.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = "flaw-t002-test";
const work = "/tmp/flaw-t002-test";
const image = "flaw-t002-app:test";
const forger = "flaw-t002-forger";
const nodeImage =
  "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";
const failures = [];

function ok(name) {
  console.log(`ok  ${name}`);
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.error(`ECHEC  ${name}: ${detail}`);
}

function assert(name, condition, detail) {
  if (condition) {
    ok(name);
  } else {
    fail(name, detail);
  }
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function uncomment(text) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function compose(args, options = {}) {
  return run(
    "docker",
    ["compose", "-p", project, "--project-directory", work, ...args],
    options,
  );
}

function staticChecks() {
  const composeText = read("infra/docker-compose.yml");
  const plain = uncomment(composeText);
  const services = plain.split(/^services:\s*$/m)[1]?.split(/^secrets:\s*$/m)[0] ?? "";
  const names = [...services.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gm)].map((match) => match[1]);
  assert(
    "services",
    JSON.stringify(names) === JSON.stringify(["caddy", "migrate", "app", "db"]),
    names.join(","),
  );
  for (const token of [
    "dockerfile_inline",
    "group_add",
    "db_superuser_password",
    "db_app_password",
    "offsite_s3",
    "restic",
    "pg_dump",
    "RESTIC_",
    "/var/run/docker.sock",
  ]) {
    assert(`compose sans ${token}`, !plain.includes(token), "présent");
  }
  const caddy = services.split(/\n {2}caddy:\n/)[1]?.split(/\n {2}migrate:\n/)[0] ?? "";
  const migrate = services.split(/\n {2}migrate:\n/)[1]?.split(/\n {2}app:\n/)[0] ?? "";
  const db = services.split(/\n {2}db:\n/)[1] ?? "";
  assert("caddy ports bas", caddy.includes('"80:80"') && caddy.includes('"443:443"') && caddy.includes('"443:443/udp"'), "ports");
  assert("caddy capability", caddy.includes("cap_add: [NET_BIND_SERVICE]") && caddy.includes("cap_drop: [ALL]"), "caps");
  assert("caddy ip fixe", caddy.includes("${CADDY_IP:-172.31.250.10}"), "ip");
  assert(
    "migrate secret unique",
    migrate.includes("secrets: [db_owner_password]") &&
      migrate.includes("DATABASE_USER: flaw_owner") &&
      !migrate.includes("app_db_password") &&
      !migrate.includes("FLAW_KEK") &&
      !migrate.includes("BETTER_AUTH"),
    "migrate",
  );
  assert("db sans durcissement incompatible", !db.includes("cap_drop") && !db.includes("read_only") && !db.includes("group_add"), "db");
  assert("db init et santé", db.includes('pg_isready -U postgres -d $${POSTGRES_DB}') && db.includes("--auth-host=scram-sha-256 --data-checksums"), "db");
  assert("réseau internal", plain.includes("internal: true") && plain.includes("${EDGE_SUBNET:-172.31.250.0/24}"), "réseau");
  assert(
    "digests",
    plain.includes("sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f") &&
      plain.includes("sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"),
    "images",
  );
  assert("journaux et mémoire", plain.includes('max-size: "10m"') && plain.includes('max-file: "5"') && plain.includes("shm_size: 128m") && plain.includes("mem_limit: 512m") && plain.includes("mem_limit: 1536m") && plain.includes("/tmp:size=64m,mode=1777"), "limites");
  assert("x-app-env", plain.includes("TRUSTED_PROXY_CIDR:") && plain.includes("PUBLIC_URL:") && plain.includes("FLAW_KEK_FILE:"), "env");

  const caddyfile = read("infra/Caddyfile");
  assert("admin off", caddyfile.includes("admin off"), "caddy");
  assert("tls 1.2", caddyfile.includes("protocols tls1.2 tls1.3"), "tls");
  assert("http3 conservé", !caddyfile.includes("h1 h2"), "protocols");
  assert("X-Real-IP", caddyfile.includes("header_up X-Real-IP {remote_host}") && caddyfile.includes("header_up -X-Forwarded-For"), "proxy");
  assert("csp du modèle", caddyfile.includes("script-src 'self' 'wasm-unsafe-eval'") && caddyfile.includes("style-src-attr 'unsafe-inline'") && !caddyfile.includes("script-src 'self' 'unsafe-eval'"), "csp");
  assert("en-têtes expert", caddyfile.includes('X-DNS-Prefetch-Control "off"') && caddyfile.includes('X-Permitted-Cross-Domain-Policies "none"') && caddyfile.includes("Cache-Control \"no-store\"") && caddyfile.includes("-X-Powered-By"), "entêtes");
  assert("acme et corps", caddyfile.includes("email {$ACME_EMAIL}") && caddyfile.includes("encode zstd gzip") && caddyfile.includes("max_size 12MB"), "caddyfile");

  const secretsScript = read("infra/creer-secrets.sh");
  const validator = read("infra/initdb/secret-valide.inc");
  assert("spec secrets", secretsScript.includes("postgres_password 70:70 400 hex32") && secretsScript.includes("app_db_password 10001:70 440 hex32") && secretsScript.includes("db_owner_password 70:70 400 hex32") && secretsScript.includes("better_auth_secret 10001:10001 400 b64_48") && secretsScript.includes("flaw_kek 10001:10001 400 kek") && secretsScript.includes("recovery_pepper 10001:10001 400 kek"), "spec");
  assert("secrets hors t002 absents", !secretsScript.includes("restic_password") && !secretsScript.includes("offsite_s3_secret") && !secretsScript.includes("sudo -E"), "script");
  assert(
    "validateur expert",
    validator.includes("motdepasse") &&
      validator.includes('substr(s, n, 1) == "\\n"') &&
      secretsScript.includes("initdb/secret-valide.inc") &&
      !secretsScript.includes("tr -d '\\r\\n'"),
    "validateur",
  );

  const initdb = read("infra/initdb/01-role-applicatif.sh");
  assert(
    "initdb même validateur",
    initdb.includes("secret-valide.inc") && !initdb.includes("tr -d '\\r\\n'"),
    "initdb",
  );
  assert(
    "rôle flaw_app",
    initdb.includes("NOREPLICATION NOBYPASSRLS") &&
      initdb.includes("CREATE SCHEMA IF NOT EXISTS flaw AUTHORIZATION flaw_owner") &&
      initdb.includes("REVOKE CREATE ON DATABASE") &&
      initdb.includes("search_path = flaw") &&
      initdb.includes("REVOKE ALL ON SCHEMA public FROM PUBLIC") &&
      !initdb.includes("AUTHORIZATION flaw_app") &&
      !initdb.includes("flaw_backup"),
    "initdb",
  );

  const example = read("infra/.env.example");
  assert("env exemple", example.includes("FLAW_DOMAIN=flaw.example.com") && example.includes("EDGE_SUBNET=172.31.250.0/24") && example.includes("CADDY_IP=172.31.250.10") && example.includes("ghcr.io/CHANGE_ME/flaw:0.1.0@sha256:CHANGE_ME"), "env");
  assert("env sans sauvegarde", !example.includes("RESTIC_") && !example.includes("BACKUP_") && !example.includes("AWS_ACCESS_KEY_ID") && !example.includes("offsite_s3"), "env");

  const dockerfile = read("apps/server/Dockerfile");
  assert(
    "dockerfile",
    dockerfile.includes("sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1") &&
      dockerfile.includes("USER 10001:10001") &&
      dockerfile.includes('CMD ["node", "apps/server/src/app.ts"]') &&
      !dockerfile.includes('CMD ["node", "src/platform/healthz.ts"]') &&
      !dockerfile.includes("server.mjs") &&
      !dockerfile.includes("db_app_password"),
    "image",
  );
  const ignore = read(".dockerignore");
  assert("dockerignore", ignore.includes("**/*.test.ts") && ignore.includes("infra/secrets") && ignore.includes(".env"), "ignore");

  for (const token of ["google-analytics", "googletagmanager", "segment.io", "plausible.io"]) {
    assert(`sans ${token}`, !composeText.includes(token) && !caddyfile.includes(token), "traceur");
  }
}

async function integration() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "initdb"), { recursive: true });
  cpSync(join(root, "infra/docker-compose.yml"), join(work, "docker-compose.yml"));
  cpSync(join(root, "infra/Caddyfile"), join(work, "Caddyfile"));
  cpSync(join(root, "infra/creer-secrets.sh"), join(work, "creer-secrets.sh"));
  cpSync(join(root, "infra/initdb/01-role-applicatif.sh"), join(work, "initdb/01-role-applicatif.sh"));
  cpSync(join(root, "infra/initdb/secret-valide.inc"), join(work, "initdb/secret-valide.inc"));
  chmodSync(join(work, "creer-secrets.sh"), 0o755);
  chmodSync(join(work, "initdb/01-role-applicatif.sh"), 0o755);
  writeFileSync(
    join(work, ".env"),
    [
      "FLAW_DOMAIN=localhost",
      "ACME_EMAIL=admin@localhost",
      "EDGE_SUBNET=172.31.250.0/24",
      "CADDY_IP=172.31.250.10",
      `FLAW_IMAGE=${image}`,
      "POSTGRES_DB=flaw",
      "LOG_LEVEL=info",
      "ALLOW_SIGNUP=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const created = run("sh", ["creer-secrets.sh"], { cwd: work });
  if (created.status !== 0) {
    fail("creer-secrets", created.stderr || created.stdout || String(created.status));
    return;
  }
  ok("creer-secrets");
  const verified = run("sh", ["creer-secrets.sh", "--verifier"], { cwd: work });
  assert("verifier", verified.status === 0, verified.stdout + verified.stderr);

  const build = run(
    "docker",
    ["build", "-f", join(root, "apps/server/Dockerfile"), "-t", image, root],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    fail("docker build", String(build.status));
    return;
  }
  ok("docker build");

  let started = false;
  try {
    const up = compose(["up", "-d"], { stdio: "inherit" });
    started = true;
    if (up.status !== 0) {
      fail("compose up", String(up.status));
      const logs = compose(["logs", "--no-color"]);
      console.error(logs.stdout);
      console.error(logs.stderr);
      return;
    }
    ok("compose up");

    const appId = compose(["ps", "-q", "app"]).stdout.trim();
    const projectLabel = run("docker", [
      "inspect",
      appId,
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}',
    ]).stdout.trim();
    assert("projet isolé", projectLabel === project, projectLabel);

    const migrateLine = compose(["ps", "-a", "--format", "{{.Service}} {{.State}} {{.ExitCode}}"]).stdout
      .split("\n")
      .find((line) => line.startsWith("migrate "));
    assert("migrate", migrateLine === "migrate exited 0", migrateLine ?? "absent");

    const redirect = await pollStdout(["curl", "-sI", "http://localhost/"], (stdout) => {
      const match = stdout.match(/^location:\s*(.+)\s*$/im);
      return match?.[1]?.trim() === "https://localhost/";
    });
    assert("redirection sans port", redirect === true, String(redirect));

    const health = await pollStdout(
      ["curl", "-sk", "https://localhost/api/v1/healthz"],
      (stdout) => {
        try {
          const body = JSON.parse(stdout);
          return body.status === "ok" && typeof body.clientIp === "string";
        } catch {
          return false;
        }
      },
    );
    assert("healthz", health === true, String(health));

    const forged = run("curl", [
      "-sk",
      "-H",
      "X-Real-IP: 203.0.113.9",
      "https://localhost/api/v1/healthz",
    ]);
    assert(
      "X-Real-IP via caddy",
      forged.status === 0 && !forged.stdout.includes("203.0.113.9") && forged.stdout.includes('"status":"ok"'),
      forged.stdout,
    );

    const forgedDirect = run("docker", [
      "run",
      "--name",
      forger,
      "--network",
      `${project}_internal`,
      "--rm",
      nodeImage,
      "node",
      "-e",
      "fetch('http://app:3000/api/v1/healthz',{headers:{'X-Real-IP':'203.0.113.9'}}).then(async (r)=>{const t=await r.text(); console.log(t); if(!r.ok||t.includes('203.0.113.9')) process.exit(2);}).catch((e)=>{console.error(e); process.exit(1);})",
    ]);
    assert(
      "X-Real-IP forgé interne",
      forgedDirect.status === 0 && !forgedDirect.stdout.includes("203.0.113.9"),
      `${forgedDirect.status} ${forgedDirect.stdout} ${forgedDirect.stderr}`,
    );

    const appUser = compose(["exec", "-T", "app", "id", "-u"]).stdout.trim();
    const dbUser = compose(["exec", "-T", "db", "id", "-u"]).stdout.trim();
    assert("uid", appUser === "10001" && dbUser === "70", `${appUser}/${dbUser}`);

    const secret = join(work, "secrets/app_db_password");
    run("chown", ["root:root", secret]);
    run("chmod", ["600", secret]);
    compose(["up", "-d", "--no-deps", "--force-recreate", "app"], { stdio: "inherit" });
    const denied = await pollLogs("EACCES");
    assert("G1 EACCES", denied, "journal sans EACCES");

    run("chown", ["10001:70", secret]);
    run("chmod", ["644", secret]);
    compose(["up", "-d", "--no-deps", "--force-recreate", "app"], { stdio: "inherit" });
    const world = await pollLogs("lisible par tous");
    assert("G1 monde", world, "journal sans refus de mode");
    run("chmod", ["440", secret]);
  } finally {
    run("docker", ["rm", "-f", forger]);
    if (started) {
      compose(["down", "-v", "--remove-orphans"], { stdio: "inherit" });
    }
    rmSync(work, { recursive: true, force: true });
  }
}

async function pollStdout(args, predicate) {
  let last = "";
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const result = run(args[0], args.slice(1));
    last = `${result.stdout}\n${result.stderr}`.trim();
    if (result.status === 0 && predicate(result.stdout)) {
      return true;
    }
    await sleep(2000);
  }
  return last;
}

async function pollLogs(needle) {
  const start = Date.now();
  while (Date.now() - start < 40_000) {
    const logs = compose(["logs", "--no-color", "app"]);
    const text = `${logs.stdout}\n${logs.stderr}`;
    if (text.includes(needle)) {
      return true;
    }
    await sleep(2000);
  }
  return false;
}

staticChecks();
const unit = run(process.execPath, ["--test", join(root, "apps/server/src/platform/healthz.test.ts")], {
  stdio: "inherit",
});
assert("healthz.test", unit.status === 0, String(unit.status));

if (typeof process.getuid === "function" && process.getuid() !== 0) {
  console.log("intégration docker non lancée : réservée à l'uid 0, sans élever les droits depuis ce script");
} else {
  await integration();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} échec(s)`);
  process.exit(1);
}
console.log("T-002 OK");
