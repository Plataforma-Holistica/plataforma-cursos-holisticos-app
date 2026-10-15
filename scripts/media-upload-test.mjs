// Sube a Mux los videos de prueba de Sergio (T-108; decisión del 2026-10-14: uno por ahora)
// y deja sus identificadores en `supabase/local/test-videos.json`, que `pnpm db:courses` usa
// para cargar esas lecciones con video de Mux en lugar del de prueba.
//
// Uso: `pnpm media:upload-test` (sube «Nature + Forest.mp4») o
//      `pnpm media:upload-test "Ocean + whales.mp4" ...`.
//
// - Solo en una máquina: se niega con CI o VERCEL. Usa MUX_TOKEN_ID y MUX_TOKEN_SECRET de
//   .env.local, que la aplicación no lee.
// - Cada video sube con política firmada: si Mux le diera un playback id público, falla.
// - Una sola vez: cada archivo viaja con su huella (passthrough), y antes de subir se busca
//   en Mux. Lo que ya está listo no se vuelve a subir.
// - Espera leyendo el estado por la API: en una máquina no llegan los avisos de Mux.
// - Nunca imprime una respuesta de la API ni una llave: solo nombres, estados y conteos.
// - Lo mismo que sabe el adaptador de Mux (src/adapters/mux/) está aquí escrito otra vez:
//   un guion de Node no importa TypeScript. Es solo para la máquina de quien desarrolla.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VIDEOS_DIR = join("..", "Videos-Test");
const OUTPUT = join("supabase", "local", "test-videos.json");
const DEFAULT_FILES = ["Nature + Forest.mp4"];
const API = "https://api.mux.com/video/v1";
const WAIT_MS = 15 * 60 * 1000;

function fail(message) {
  console.error(`media:upload-test: ${message}`);
  process.exit(1);
}

if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en la integración continua ni en Vercel: sube videos de una máquina.");
}
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const tokenId = process.env.MUX_TOKEN_ID;
const tokenSecret = process.env.MUX_TOKEN_SECRET;
if (!tokenId || !tokenSecret) fail("faltan MUX_TOKEN_ID y MUX_TOKEN_SECRET en .env.local. Mira .env.example.");
const auth = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;

const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;
for (const file of files) {
  // Solo un nombre de archivo de esa carpeta: sin rutas, sin «..» y sin ocultos.
  if (!/^[^/\\]+$/.test(file) || file.startsWith(".") || !existsSync(join(VIDEOS_DIR, file))) fail(`no está ${file} en ${VIDEOS_DIR}.`);
}

/** Una llamada a la API. Sin el cuerpo de la respuesta en ningún mensaje. */
async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) fail(`Mux contestó ${response.status} a ${method} ${path.replace(/\/[A-Za-z0-9]{10,}/g, "/…")}.`);
  return (await response.json()).data;
}

async function fingerprint(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(VIDEOS_DIR, file))) hash.update(chunk);
  return `prueba-${hash.digest("hex").slice(0, 40)}`;
}

/** El asset que ya trae esa huella, si Mux lo tiene. */
async function findAsset(passthrough) {
  for (let page = 1; page <= 20; page += 1) {
    const assets = await api("GET", `/assets?limit=100&page=${page}`);
    const found = assets.find((asset) => asset.passthrough === passthrough && asset.status !== "errored");
    if (found) return found;
    if (assets.length < 100) return null;
  }
  // Sin haberla visto toda no se sabe si ya está: no se sube a ciegas.
  fail("Mux tiene más de 2000 videos y no se revisaron todos: búscalo a mano en el panel.");
}

async function upload(file, passthrough) {
  const created = await api("POST", "/uploads", {
    cors_origin: "http://localhost:3000",
    new_asset_settings: { playback_policy: ["signed"], passthrough, video_quality: "basic" },
  });
  const size = statSync(join(VIDEOS_DIR, file)).size;
  console.log(`media:upload-test: subiendo ${file} (${Math.round(size / 1024 / 1024)} MB)…`);
  const put = await fetch(created.url, {
    method: "PUT",
    body: createReadStream(join(VIDEOS_DIR, file)),
    headers: { "Content-Length": String(size) },
    duplex: "half",
  });
  if (!put.ok) fail(`la subida de ${file} contestó ${put.status}.`);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const state = await api("GET", `/uploads/${created.id}`);
    if (state.asset_id) return state.asset_id;
    if (state.status === "errored" || state.status === "cancelled" || Date.now() > deadline) fail(`la subida de ${file} quedó en ${state.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function ready(assetId, file) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const asset = await api("GET", `/assets/${assetId}`);
    if (asset.status === "ready") return asset;
    if (asset.status === "errored" || Date.now() > deadline) fail(`${file} quedó en ${asset.status} en Mux.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const saved = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : {};
const result = { ...saved };
for (const file of files) {
  const passthrough = await fingerprint(file);
  let asset = await findAsset(passthrough);
  if (asset) console.log(`media:upload-test: ${file} ya estaba en Mux.`);
  else asset = { id: await upload(file, passthrough) };
  asset = await ready(asset.id, file);
  const playbacks = asset.playback_ids ?? [];
  // Todo video es privado (TRD §6.6): uno público se dice y no se usa.
  if (playbacks.some((playback) => playback.policy !== "signed")) fail(`${file} tiene un playback id público en Mux: quítalo desde el panel.`);
  const signed = playbacks.find((playback) => playback.policy === "signed");
  if (!signed || !(asset.duration > 0)) fail(`${file} no quedó con un playback id firmado y su duración.`);
  result[file] = { asset_id: asset.id, playback_id: signed.id, duration_seconds: Math.round(asset.duration) };
  console.log(`media:upload-test: ${file} listo (${Math.round(asset.duration)} s).`);
}
// Todo o nada: se escribe al final, ya con todos listos.
writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`media:upload-test: ${Object.keys(result).length} video(s) en ${OUTPUT}. Para usarlos: pnpm db:reset && pnpm db:courses.`);
