// Le agrega a un video de prueba de Mux la pista de subtítulos escrita a mano
// (`supabase/local/test-captions.es.vtt`), para revisar los subtítulos en el reproductor (T-203;
// decisión de Sergio del 2026-10-15: una sola pista VTT, en español, en su cuenta de Mux; los
// subtítulos automáticos se deciden con T-403).
//
// Uso: `pnpm media:captions-test` (a «Nature + Forest.mp4») o
//      `pnpm media:captions-test "Ocean + whales.mp4"`. El video ya tiene que estar subido con
//      `pnpm media:upload-test`: su asset sale de `supabase/local/test-videos.json`.
//
// - Solo en una máquina: se niega con CI o VERCEL. Usa MUX_TOKEN_ID y MUX_TOKEN_SECRET de
//   .env.local, que la aplicación no lee.
// - Mux no recibe el archivo: lo descarga de una dirección pública. Es la del archivo en GitHub,
//   en el commit en que está la rama (el repositorio es público). Antes de pedírselo a Mux, la
//   descarga y la compara con la de esta máquina: si no está subida o cambió, se detiene.
// - Una sola vez: la pista viaja con la huella del archivo (passthrough). Si el video ya la
//   tiene, no hace nada; si tiene otra pista de prueba, se detiene: se quita a mano en el panel.
// - Espera leyendo el estado por la API, y nunca imprime una respuesta de la API ni una llave.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CAPTIONS = join("supabase", "local", "test-captions.es.vtt");
const CAPTIONS_PATH = "supabase/local/test-captions.es.vtt";
const VIDEOS = join("supabase", "local", "test-videos.json");
const DEFAULT_FILE = "Nature + Forest.mp4";
const API = "https://api.mux.com/video/v1";
const PREFIX = "subtitulos-prueba-";
const WAIT_MS = 5 * 60 * 1000;

function fail(message) {
  console.error(`media:captions-test: ${message}`);
  process.exit(1);
}

if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en la integración continua ni en Vercel: actúa sobre la cuenta de Mux de una máquina.");
}
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const tokenId = process.env.MUX_TOKEN_ID;
const tokenSecret = process.env.MUX_TOKEN_SECRET;
if (!tokenId || !tokenSecret) fail("faltan MUX_TOKEN_ID y MUX_TOKEN_SECRET en .env.local. Mira .env.example.");
const auth = `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;

const file = process.argv[2] ?? DEFAULT_FILE;
const videos = existsSync(VIDEOS) ? JSON.parse(readFileSync(VIDEOS, "utf8")) : {};
const assetId = videos[file]?.asset_id;
if (typeof assetId !== "string" || !/^[A-Za-z0-9]+$/.test(assetId)) fail(`${file} no está en ${VIDEOS}: súbelo antes con pnpm media:upload-test.`);

const captions = readFileSync(CAPTIONS);
if (!captions.subarray(0, 6).equals(Buffer.from("WEBVTT"))) fail(`${CAPTIONS} no empieza con WEBVTT.`);
const passthrough = `${PREFIX}${createHash("sha256").update(captions).digest("hex").slice(0, 40)}`;

/** De dónde la descarga Mux: el archivo en GitHub, en el commit de esta rama. */
function publicUrl() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const remote = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"));
  if (!remote) fail("el remoto origin no es de GitHub.");
  const commit = git("rev-parse", "HEAD");
  return `https://raw.githubusercontent.com/${remote[1]}/${remote[2]}/${commit}/${CAPTIONS_PATH}`;
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

const textTracks = (asset) => (asset.tracks ?? []).filter((track) => track.type === "text");

const asset = await api("GET", `/assets/${assetId}`);
if (asset.status !== "ready") fail(`${file} no está listo en Mux (${asset.status}).`);
const ours = textTracks(asset).filter((track) => typeof track.passthrough === "string" && track.passthrough.startsWith(PREFIX));
if (ours.some((track) => track.passthrough === passthrough && track.status === "ready")) {
  console.log(`media:captions-test: ${file} ya tiene la pista de prueba.`);
  process.exit(0);
}
// Sergio autorizó una sola pista: otra versión, o una a medias, se quita a mano en el panel.
if (ours.length > 0) fail(`${file} ya tiene otra pista de prueba en Mux (${ours.length}). Quítala en el panel y vuelve a correr esto.`);

const url = publicUrl();
const published = await fetch(url);
if (!published.ok) fail(`GitHub contestó ${published.status} al archivo de este commit: sube la rama antes (git push).`);
if (!Buffer.from(await published.arrayBuffer()).equals(captions)) fail("el archivo en GitHub no es el de esta máquina: sube la rama antes (git push).");

const track = await api("POST", `/assets/${assetId}/tracks`, {
  url,
  type: "text",
  text_type: "subtitles",
  language_code: "es",
  name: "Español",
  closed_captions: false,
  passthrough,
});
console.log(`media:captions-test: Mux está preparando la pista de ${file}…`);
const deadline = Date.now() + WAIT_MS;
for (;;) {
  const now = textTracks(await api("GET", `/assets/${assetId}`)).find((each) => each.id === track.id);
  if (now?.status === "ready") break;
  if (!now || now.status === "errored" || Date.now() > deadline) fail(`la pista quedó en ${now?.status ?? "nada"} en Mux.`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
console.log(`media:captions-test: ${file} ya tiene la pista de prueba. Se ve en la lección con pnpm db:reset && pnpm db:courses.`);
