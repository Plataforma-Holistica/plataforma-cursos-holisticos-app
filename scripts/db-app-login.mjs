// Da entrada a app_service en la base LOCAL, con la contraseña que venga en DATABASE_URL.
//
// La migración crea el rol sin permiso de entrada y sin contraseña: cada entorno se los da
// fuera del repositorio (esquema de backend §16.1). En local lo hace este guion, que corre
// con `pnpm db:login` y después de cada `pnpm db:reset`, porque rehacer la base borra los
// roles. Fuera de local se niega a correr.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ITERATIONS = 4096;

function fail(message) {
  console.error(`db:login: ${message}`);
  process.exit(1);
}

function readUrl(name) {
  const value = process.env[name];
  if (!value) fail(`falta ${name}. Mira .env.example.`);
  try {
    return new URL(value);
  } catch {
    return fail(`${name} no es una URL.`);
  }
}

// El verificador SCRAM-SHA-256 se calcula aquí: la contraseña no viaja en claro en la
// sentencia ni puede quedar en los registros de la base.
function scramVerifier(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const b64 = (buffer) => buffer.toString("base64");
  return `SCRAM-SHA-256$${ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

// Lo que ya está en el entorno gana sobre el archivo: así la integración continua pasa
// sus propios valores.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const appUrl = readUrl("DATABASE_URL");
const adminUrl = readUrl("DATABASE_URL_DIRECT");

for (const [name, url] of [
  ["DATABASE_URL", appUrl],
  ["DATABASE_URL_DIRECT", adminUrl],
]) {
  if (!LOCAL_HOSTS.has(url.hostname)) {
    fail(`${name} no apunta a la base local. Este guion solo corre contra 127.0.0.1 o localhost.`);
  }
  // `pg` deja que los parámetros de la cadena manden sobre lo demás: con `?host=` este
  // guion pasaría por local y le cambiaría la contraseña al rol de una base remota.
  if ([...url.searchParams.keys()].length > 0) {
    fail(`${name} no puede traer parámetros.`);
  }
}

if (appUrl.username !== "app_service") {
  fail("DATABASE_URL debe entrar como app_service. Mira .env.example.");
}
if (adminUrl.username === "app_service") {
  fail("DATABASE_URL_DIRECT debe entrar como postgres, no como app_service.");
}

const password = decodeURIComponent(appUrl.password);
if (password.length < 12) {
  fail("la contraseña de app_service en DATABASE_URL debe tener al menos 12 caracteres.");
}

const verifier = scramVerifier(password);
// El verificador va entre comillas en la sentencia: solo puede traer estos caracteres.
if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) {
  fail("el verificador calculado no tiene la forma esperada.");
}

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: adminUrl.hostname.replace(/^\[|\]$/g, ""),
  port: adminUrl.port === "" ? 5432 : Number(adminUrl.port),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
  database: decodeURIComponent(adminUrl.pathname.replace(/^\//, "")),
});
try {
  await client.connect();
  await client.query(`alter role app_service login password '${verifier}'`);
  console.log("db:login: app_service ya puede entrar a la base local.");
} catch (error) {
  // El mensaje de Postgres no trae la contraseña; el objeto completo sí podría.
  fail(`no se pudo dar entrada a app_service (${error.code ?? "sin código"}): ${error.message}`);
} finally {
  await client.end().catch(() => {});
}
