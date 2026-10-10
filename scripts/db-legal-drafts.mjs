// Carga en la base LOCAL los textos legales de borrador (versión 0), para poder construir
// y probar el registro antes de que el abogado entregue los textos reales.
//
// No es una semilla, y a propósito: `supabase/seeds/` viaja con cualquier siembra, también
// a una base remota. Este guion solo corre contra la base local (`pnpm db:drafts`, y al
// final de `pnpm db:reset`), y la base rechaza una versión 0 que no venga del dueño de la
// tabla, declarado como sistema y con el ajuste que se pone aquí (esquema de backend §5.8).
//
// Los textos viven en `supabase/local/legal-drafts/`, un archivo por tipo: la primera
// línea, `# Título`, y el resto, el cuerpo. El guion no ejecuta SQL que venga de un
// archivo: inserta con una sentencia fija y los textos como parámetros.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DRAFTS_DIR = join("supabase", "local", "legal-drafts");
// La misma fecha de arranque que la semilla de parámetros: fija y anterior a toda versión
// publicada, para que una versión 1 siempre quede por delante del borrador.
const EFFECTIVE_FROM = "2026-10-01 06:00:00+00";

// Los únicos tipos que se cargan como borrador: los tres textos sin los que no se puede
// completar un registro (RF-108). Un archivo con otro nombre es un error.
const DRAFTS = new Map([
  ["terms.md", { docType: "terms", requiresReconsent: true }],
  ["student_privacy_notice.md", { docType: "student_privacy_notice", requiresReconsent: true }],
  ["course_history_consent.md", { docType: "course_history_consent", requiresReconsent: false }],
]);

function fail(message) {
  console.error(`db:drafts: ${message}`);
  process.exit(1);
}

// Lo que ya está en el entorno gana sobre el archivo: así la integración continua pasa
// sus propios valores.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

if (process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en Vercel: los borradores solo existen en una base local.");
}

const raw = process.env.DATABASE_URL_DIRECT;
if (!raw) fail("falta DATABASE_URL_DIRECT. Mira .env.example.");
let url;
try {
  url = new URL(raw);
} catch {
  fail("DATABASE_URL_DIRECT no es una URL.");
}
if (!LOCAL_HOSTS.has(url.hostname)) {
  fail("DATABASE_URL_DIRECT no apunta a la base local. Este guion solo corre contra 127.0.0.1 o localhost.");
}
// `pg` deja que los parámetros de la cadena manden sobre lo demás: con `?host=` este
// guion pasaría por local y escribiría en una base remota.
if ([...url.searchParams.keys()].length > 0) {
  fail("DATABASE_URL_DIRECT no puede traer parámetros.");
}
// Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene
// un usuario y una contraseña de fábrica que ninguna base remota tiene.
if (decodeURIComponent(url.username) !== "postgres" || decodeURIComponent(url.password) !== "postgres") {
  fail("DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.");
}

function readDrafts() {
  if (!existsSync(DRAFTS_DIR)) fail(`no existe ${DRAFTS_DIR}.`);
  const files = readdirSync(DRAFTS_DIR).sort();
  for (const file of files) {
    if (!DRAFTS.has(file)) fail(`${file} no es un borrador conocido. Los tipos están en este guion.`);
  }
  return [...DRAFTS].map(([file, meta]) => {
    if (!files.includes(file)) fail(`falta el borrador ${file}.`);
    // Los saltos de línea se igualan: la huella no debe depender de en qué sistema se
    // descargó el repositorio.
    const text = readFileSync(join(DRAFTS_DIR, file), "utf8").replace(/\r\n/g, "\n");
    const newline = text.indexOf("\n");
    const heading = /^# (.+)$/.exec(newline === -1 ? text : text.slice(0, newline));
    const body = newline === -1 ? "" : text.slice(newline + 1).trim();
    if (!heading || body === "") fail(`${file} debe empezar con "# Título" y traer un cuerpo.`);
    return { ...meta, file, title: heading[1].trim(), body };
  });
}

const drafts = readDrafts();

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: url.hostname.replace(/^\[|\]$/g, ""),
  port: url.port === "" ? 5432 : Number(url.port),
  user: "postgres",
  password: "postgres",
  database: decodeURIComponent(url.pathname.replace(/^\//, "")),
});

let changed = [];
try {
  await client.connect();
  await client.query("begin");
  // Lo carga el sistema, no una persona: queda así en la auditoría.
  await client.query("select set_config('app.actor_kind', 'system', true), set_config('app.legal_drafts', 'on', true)");
  for (const draft of drafts) {
    await client.query(
      `insert into public.legal_documents (doc_type, version, title, body, effective_from, requires_reconsent)
       values ($1::public.legal_doc_type, 0, $2, $3, $4::timestamptz, $5)
       on conflict (doc_type, version) do nothing`,
      [draft.docType, draft.title, draft.body, EFFECTIVE_FROM, draft.requiresReconsent],
    );
  }
  // Un texto legal no se edita. Si el archivo cambió después de cargarse, la base conserva
  // el anterior: se avisa, en vez de dejar creer que el cambio entró.
  const stored = await client.query(
    "select doc_type::text as doc_type, encode(body_sha256, 'hex') as hash from public.legal_documents where version = 0",
  );
  const hashes = new Map(stored.rows.map((row) => [row.doc_type, row.hash]));
  changed = drafts.filter(
    (draft) => hashes.get(draft.docType) !== createHash("sha256").update(draft.body, "utf8").digest("hex"),
  );
  await client.query("commit");
} catch (error) {
  await client.query("rollback").catch(() => {});
  fail(`no se pudieron cargar los borradores (${error.code ?? "sin código"}): ${error.message}`);
} finally {
  await client.end().catch(() => {});
}

if (changed.length > 0) {
  fail(
    `la base tiene otra versión de ${changed.map((draft) => draft.file).join(", ")}. ` +
      "Un texto legal no se edita: corre `pnpm db:reset` para cargar el archivo nuevo.",
  );
}
console.log(`db:drafts: ${drafts.length} borradores legales en la base local (versión 0).`);
