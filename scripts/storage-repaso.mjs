// El repaso de los recursos (T-404; decisión de Sergio del 2026-10-30) en la base LOCAL: se lleva los pendientes
// vencidos (`private.resource_sweep()`, que dice qué objetos ninguna fila nombra) y los borra de la cubeta por la API
// de Storage. Cubre lo que borrar al momento no alcanza: una caída entre la base y Storage, o una subida que terminó
// después de que su fila se fue.
//
//   pnpm storage:repaso            # dice qué sobra y lo borra
//   pnpm storage:repaso --ver      # solo dice cuántos sobran, y no toca nada: lo que barre se revierte
//
// Solo corre contra la pila local, como los demás guiones. En producción lo hace quien opera, con los pasos del
// manual (`../planeacion/08-manual-operacion.md`). De un error imprime solo el código, y nunca una llave ni una ruta.

import { existsSync } from "node:fs";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BUCKET = "course-resources";

function fail(message) {
  console.error(`storage:repaso: ${message}`);
  process.exit(1);
}

const codeOf = (error) => {
  const code = error?.code ?? error?.status ?? error?.name;
  return typeof code === "string" || typeof code === "number" ? String(code) : "desconocido";
};

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) fail("no corre en la integración continua ni en Vercel.");
if (process.env.APP_ENV !== "local") fail("APP_ENV no es local.");

function localUrl(name) {
  const raw = process.env[name];
  if (!raw) fail(`falta ${name}. Mira .env.example.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} no es una URL.`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) fail(`${name} no apunta a la pila local.`);
  return url;
}

const direct = localUrl("DATABASE_URL_DIRECT");
const api = localUrl("NEXT_PUBLIC_SUPABASE_URL");
const secret = process.env.SUPABASE_SECRET_KEY;
if (!secret) fail("falta SUPABASE_SECRET_KEY. Mira .env.example.");
const onlyLook = process.argv.includes("--ver");

const client = new pg.Client({
  host: direct.hostname.replace(/^\[|\]$/g, ""),
  port: direct.port === "" ? 5432 : Number(direct.port),
  user: decodeURIComponent(direct.username),
  password: decodeURIComponent(direct.password),
  database: decodeURIComponent(direct.pathname.replace(/^\//, "")),
});

let paths;
try {
  await client.connect();
  await client.query("begin");
  paths = (await client.query("select path from private.resource_sweep()")).rows.map((row) => row.path);
  await client.query(onlyLook ? "rollback" : "commit");
} catch (error) {
  fail(`no se pudo leer la base (${codeOf(error)}).`);
} finally {
  await client.end().catch(() => {});
}

console.log(`storage:repaso: ${paths.length} objeto(s) que ninguna fila nombra.`);
if (onlyLook || paths.length === 0) process.exit(0);

const response = await fetch(`${api.origin}/storage/v1/object/${BUCKET}`, {
  method: "DELETE",
  headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify({ prefixes: paths }),
}).catch((error) => fail(`Storage no contestó (${codeOf(error)}).`));
if (!response.ok) fail(`Storage contestó ${response.status}.`);
console.log(`storage:repaso: borrados.`);
