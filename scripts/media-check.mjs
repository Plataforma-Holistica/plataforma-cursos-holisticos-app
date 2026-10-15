// La comprobación de T-108 contra Mux (fuera de la integración continua): con una dirección
// firmada vigente Mux sirve el video; con una caducada, o sin firma, lo rechaza.
//
// Uso: `pnpm media:check`, después de `pnpm media:upload-test`. Usa la llave de firma de
// .env.local y el primer video de `supabase/local/test-videos.json`. Solo imprime estados.
// Firma igual que el adaptador (src/adapters/mux/sign.ts): un guion de Node no importa
// TypeScript.

import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VIDEOS_FILE = join("supabase", "local", "test-videos.json");

function fail(message) {
  console.error(`media:check: ${message}`);
  process.exit(1);
}

// Firma fuera de la función única de medios, y por eso solo en una máquina.
if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) fail("no corre en la integración continua ni en Vercel: es una comprobación de una máquina.");
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const keyId = process.env.MUX_SIGNING_KEY_ID;
const raw = process.env.MUX_SIGNING_PRIVATE_KEY;
if (!keyId || !raw) fail("faltan MUX_SIGNING_KEY_ID y MUX_SIGNING_PRIVATE_KEY en .env.local.");
if (!existsSync(VIDEOS_FILE)) fail(`no existe ${VIDEOS_FILE}: corre antes pnpm media:upload-test.`);
const [file, video] = Object.entries(JSON.parse(readFileSync(VIDEOS_FILE, "utf8")))[0] ?? [];
if (!video) fail(`${VIDEOS_FILE} no trae ningún video.`);

let key;
try {
  key = createPrivateKey(raw.includes("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8"));
} catch {
  fail("la llave de firma no es una llave privada.");
}

const b64 = (value) => Buffer.from(value).toString("base64url");
function token(exp) {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = b64(JSON.stringify({ sub: video.playback_id, aud: "v", exp }));
  return `${header}.${payload}.${b64(sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key))}`;
}

const manifest = (query) => fetch(`https://stream.mux.com/${video.playback_id}.m3u8${query}`).then((response) => response.status);
const now = Math.floor(Date.now() / 1000);
const checks = [
  ["con una dirección vigente", await manifest(`?token=${token(now + 600)}`), 200],
  ["con una dirección caducada", await manifest(`?token=${token(now - 60)}`), 403],
  ["sin firma", await manifest(""), 403],
];
let ok = true;
for (const [what, got, want] of checks) {
  const good = got === want;
  ok &&= good;
  console.log(`media:check: ${file} ${what}: ${got} (${good ? "bien" : `se esperaba ${want}`})`);
}
if (!ok) process.exit(1);
