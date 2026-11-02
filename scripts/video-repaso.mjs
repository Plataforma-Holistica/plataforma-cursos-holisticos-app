// El repaso de los videos (T-403) en la base LOCAL: vence lo que toca (`private.video_sweep()`, que dice qué hay en la papelera, qué sobra en la cubeta y qué lleva más de un día
// sin terminar), le borra a Mux y a la cubeta lo que ya nadie nombra, y saca de la papelera lo que quedó borrado. Alcanza lo que el editor no: la papelera de un curso que ya no se
// abre o que se borró. Un renglón reclamado y sin asset se busca por `passthrough` antes de sacarlo, porque Mux pudo haberlo creado; la base no lo da hasta 5 minutos después, porque un
// asset recién creado puede no aparecer todavía en la lista. Si no se pudo buscar o borrar, el renglón se queda.
//
//   pnpm video:repaso            # dice qué hay y lo borra
//   pnpm video:repaso --ver      # solo dice cuántos hay, y no toca nada: lo que barre se revierte
//
// Solo corre contra la pila local, como los demás guiones. En producción lo hace quien opera, con los pasos del manual (`../planeacion/08-manual-operacion.md`, OP-21). Repite lo que
// sabe el adaptador de Mux: un guion de Node no importa TypeScript. De un error imprime solo el código, y nunca una llave, una ruta ni una respuesta de la API.

import { existsSync } from "node:fs";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BUCKET = "video-originals";
const MUX = "https://api.mux.com/video/v1/assets";
/** Lo mismo que el adaptador: el renglón pudo nacer antes que el asset por el reloj de cualquiera de los dos. */
const MARGIN_SECONDS = 3_600;
const PAGE = 100;
const MAX_PAGES = 200;
const TIMEOUT_MS = 20_000;

function fail(message) {
  console.error(`video:repaso: ${message}`);
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
const muxId = process.env.MUX_TOKEN_ID;
const muxSecret = process.env.MUX_TOKEN_SECRET;
const muxHeaders = muxId && muxSecret ? { authorization: `Basic ${Buffer.from(`${muxId}:${muxSecret}`).toString("base64")}` } : null;
const onlyLook = process.argv.includes("--ver");

const client = new pg.Client({
  host: direct.hostname.replace(/^\[|\]$/g, ""),
  port: direct.port === "" ? 5432 : Number(direct.port),
  user: decodeURIComponent(direct.username),
  password: decodeURIComponent(direct.password),
  database: decodeURIComponent(direct.pathname.replace(/^\//, "")),
});

/** Los assets de Mux con ese `passthrough`, o nulo si no se pudo terminar de buscar. Mux no filtra por él, y va del más nuevo al más viejo. */
async function findByPassthrough(video, since) {
  const found = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${MUX}?limit=${PAGE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const response = await fetch(url, { headers: muxHeaders, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.data)) return null;
    let past = false;
    for (const asset of body.data) {
      if (asset.passthrough === video) found.push(asset.id);
      if (Number(asset.created_at) < since - MARGIN_SECONDS) past = true;
    }
    if (past || !body.next_cursor) return found;
    cursor = body.next_cursor;
  }
  return null;
}

/** Si Mux ya no lo tiene. Un 404 cuenta como borrado. */
async function removeAsset(asset) {
  const response = await fetch(`${MUX}/${encodeURIComponent(asset)}`, { method: "DELETE", headers: muxHeaders, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  return response !== null && (response.ok || response.status === 404);
}

async function removeObjects(paths) {
  if (paths.length === 0) return true;
  const response = await fetch(`${api.origin}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ prefixes: paths }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  return response?.ok === true;
}

/** Borra lo que el renglón nombra. Sin llaves, lo que está en Mux espera: lo del proveedor de prueba no está en ninguna parte. */
async function clearTrash(row) {
  if (row.provider === "mux" && (row.asset !== null || row.claimed_since !== null)) {
    if (muxHeaders === null) return false;
    const assets = row.asset !== null ? [row.asset] : await findByPassthrough(row.video, Math.floor(new Date(row.claimed_since).getTime() / 1000));
    if (assets === null) return false;
    for (const asset of assets) {
      if (!(await removeAsset(asset))) return false;
    }
  }
  return removeObjects(row.path === null ? [] : [row.path]);
}

let rows = [];
try {
  await client.connect();
  await client.query("begin");
  rows = (await client.query("select kind, path, video, asset, provider, trash_id, claimed_since from private.video_sweep()")).rows;
  await client.query(onlyLook ? "rollback" : "commit");
} catch (error) {
  await client.end().catch(() => {});
  fail(`no se pudo leer la base (${codeOf(error)}).`);
}

const trash = rows.filter((row) => row.kind === "trash");
const orphans = rows.filter((row) => row.kind === "orphan");
const stuck = rows.filter((row) => row.kind === "stuck");
console.log(`video:repaso: ${trash.length} en la papelera, ${orphans.length} que ninguna fila nombra, ${stuck.length} sin terminar desde hace más de un día.`);
// Lo que sigue nombrado no se toca: se decide a mano (OP-21).
for (const row of stuck) console.log(`video:repaso: sin terminar: ${row.video}`);

let left = 0;
try {
  if (!onlyLook) {
    for (const row of trash) {
      if (await clearTrash(row)) await client.query("delete from private.video_trash where id = $1", [row.trash_id]);
      else left += 1;
    }
    if (!(await removeObjects(orphans.map((row) => row.path)))) fail("Storage no borró lo que sobra.");
  }
} catch (error) {
  fail(`no se pudo terminar (${codeOf(error)}).`);
} finally {
  await client.end().catch(() => {});
}
if (!onlyLook) console.log(`video:repaso: ${left === 0 ? "listo." : `${left} se quedaron en la papelera: no se pudieron buscar o borrar.`}`);
